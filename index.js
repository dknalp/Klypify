const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs-extra');
const path = require('path');

const { execFile, execFileSync } = require('child_process');

// Resolve encoder lazily when processVideo is first called
let gpuEncoderConfig = null;
let _ffmpegPath = ffmpeg.getFfmpegPath ? ffmpeg.getFfmpegPath() : path.join(__dirname, 'bin', 'ffmpeg');

function hwaccelInputOptions() {
    const name = gpuEncoderConfig && gpuEncoderConfig.name;
    if (name === 'h264_nvenc') return ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'];
    if (name === 'h264_qsv')   return ['-hwaccel', 'qsv'];
    if (name === 'h264_amf')   return ['-hwaccel', 'd3d11va'];
    if (name === 'h264_vaapi') return ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128', '-hwaccel_output_format', 'vaapi'];
    if (name === 'h264_videotoolbox') return ['-hwaccel', 'videotoolbox'];
    return [];
}

function probeEncoderSync(ffmpegPath, args) {
    try {
        execFileSync(ffmpegPath, args, { timeout: 8000, stdio: 'pipe' });
        return true;
    } catch (_) { return false; }
}

async function resolveEncoder() {
    if (gpuEncoderConfig) return;
    const frame = ['-hide_banner', '-f', 'lavfi', '-i', 'color=black:s=256x256:d=0.2'];
    const crf = '20';
    const candidates = [
        { name: 'h264_nvenc',  test: [...frame, '-c:v', 'h264_nvenc', '-f', 'null', '-'],
          segmentOptions: (c) => ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc:v', 'vbr', '-cq:v', String(c), '-b:v', '0', '-bf', '0'],
          label: 'NVIDIA NVENC (GPU)' },
        { name: 'h264_vaapi',  test: [...frame, '-vaapi_device', '/dev/dri/renderD128', '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'],
          segmentOptions: (c) => ['-c:v', 'h264_vaapi', '-qp', String(c)], label: 'Intel VAAPI (GPU)' },
    ];
    for (const c of candidates) {
        if (probeEncoderSync(ffmpegPath, c.test)) {
            gpuEncoderConfig = c;
            console.log(`[GPU] index.js encoder: ${c.label}`);
            return;
        }
    }
    gpuEncoderConfig = {
        name: 'libx264', label: 'CPU (libx264)',
        segmentOptions: (c) => ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(c)],
    };
    console.log('[GPU] index.js encoder: CPU fallback (libx264)');
}



// Set FFmpeg binary paths
const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg');
const ffprobePath = path.join(__dirname, 'bin', 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Parameters for silence analysis
const SILENCE_DB = '-45dB';  // Consider sounds below -45dB as silence
const MIN_SILENCE_DURATION = 0.6;  // Minimum silence duration (seconds)
const PADDING_DURATION = 0.05;  // Padding duration at the start and end of silence (seconds)

async function detectSilence(inputFile) {
    console.log(`\n[Silence Detection] Starting: ${inputFile}`);
    console.log(`[Silence Detection] Parameters: Silence threshold=${SILENCE_DB}, Min duration=${MIN_SILENCE_DURATION}s, Padding=${PADDING_DURATION}s`);
    
    return new Promise((resolve, reject) => {
        let silenceRanges = [];
        let startTime = null;

        ffmpeg(inputFile)
            .outputOptions(['-f', 'null'])
            .audioFilters(`silencedetect=noise=${SILENCE_DB}:d=${MIN_SILENCE_DURATION}`)
            .output('-')
            .on('start', command => {
                console.log(`[FFmpeg Command] ${command}`);
            })
            .on('stderr', line => {
                const silenceStart = line.match(/silence_start: ([\d.]+)/);
                const silenceEnd = line.match(/silence_end: ([\d.]+)/);

                if (silenceStart) {
                    startTime = parseFloat(silenceStart[1]);
                    console.log(`[Silence Start] ${startTime}s`);
                }
                if (silenceEnd && startTime !== null) {
                    const endTime = parseFloat(silenceEnd[1]);
                    const duration = endTime - startTime;
                    console.log(`[Silence End] ${endTime}s (Duration: ${duration.toFixed(2)}s)`);
                    
                    silenceRanges.push({
                        start: startTime + PADDING_DURATION,
                        end: endTime - PADDING_DURATION
                    });
                    startTime = null;
                }
            })
            .on('end', () => {
                console.log(`[Silence Detection] Completed. Found ${silenceRanges.length} silence ranges.`);
                silenceRanges.forEach((range, index) => {
                    console.log(`  Range ${index + 1}: ${range.start.toFixed(2)}s - ${range.end.toFixed(2)}s`);
                });
                resolve(silenceRanges);
            })
            .on('error', (err) => {
                console.error(`[Silence Detection Error] ${err.message}`);
                reject(err);
            })
            .run();
    });
}

async function processVideo(inputFile) {
    try {
        console.log(`\n[Video Processing] Starting: ${inputFile}`);
        
        // Check input file accessibility
        try {
            await fs.access(inputFile, fs.constants.R_OK);
            console.log(`[Video Processing] Input file is readable: ${inputFile}`);
        } catch (err) {
            throw new Error(`Input file is not readable: ${err.message}`);
        }

        const outputFile = path.join(
            path.dirname(inputFile),
            `processed_${path.basename(inputFile)}`
        );

        // Delete output file if exists
        try {
            await fs.remove(outputFile);
            console.log(`[Video Processing] Old output file cleaned: ${outputFile}`);
        } catch (err) {
            console.log(`[Video Processing] Old output file not found: ${outputFile}`);
        }

        // Detect silences
        const silenceRanges = await detectSilence(inputFile);

        if (silenceRanges.length === 0) {
            console.log('[Video Processing] No silence found, copying file...');
            await fs.copyFile(inputFile, outputFile);
            return outputFile;
        }

        // Combine non-silent parts
        return new Promise((resolve, reject) => {
            // Create a select filter that skips silent parts
            let selectParts = [];
            
            // First part (from start to first silence)
            if (silenceRanges[0].start > 0) {
                selectParts.push(`between(t,0,${silenceRanges[0].start})`);
            }

            // Parts between silences
            for (let i = 0; i < silenceRanges.length - 1; i++) {
                selectParts.push(
                    `between(t,${silenceRanges[i].end},${silenceRanges[i + 1].start})`
                );
            }

            // Last part (from last silence to end)
            const lastSilence = silenceRanges[silenceRanges.length - 1];
            selectParts.push(`gte(t,${lastSilence.end})`);

            // Create select filter
            const selectFilter = selectParts.join('+');

            // Video and audio filters
            const command = ffmpeg(inputFile)
                .inputOptions([
                    '-y',                    // Overwrite output file
                    '-loglevel', 'verbose',  // Detailed logging
 ...hwaccelInputOptions()
                ])
                .videoFilters([
                    `select='${selectFilter}'`,
                    'setpts=N/FRAME_RATE/TB'
                ])
                .audioFilters([
                    `aselect='${selectFilter}'`,
                    'asetpts=N/SR/TB'
                ])
                .outputOptions([
 // Video encoder matches the GPU detected in main.js (CPU only if none exists)
 ...gpuEncoderConfig.segmentOptions(20),
 '-c:a', 'aac',
 '-b:a', '192k',
 '-movflags', '+faststart',
 '-max_muxing_queue_size', '9999'
                ]);

            // Log FFmpeg command
            command.on('start', cmd => {
                console.log('\n[FFmpeg Full Command]');
                console.log(cmd);
            });

            // Log FFmpeg stderr output
            command.on('stderr', line => {
                if (line.includes('Error') || line.includes('Invalid') || line.includes('No such')) {
                    console.error(`[FFmpeg Error] ${line}`);
                } else {
                    console.log(`[FFmpeg Log] ${line}`);
                }
            });

            // Show progress
            command.on('progress', progress => {
                const percent = progress.percent ? progress.percent.toFixed(1) : '0';
                const time = progress.timemark || '00:00:00';
                console.log(`[Progress] ${percent}% completed (${time})`);
            });

            // Handle process result
            command.on('end', () => {
                console.log('[Video Processing] Successfully completed');
                resolve(outputFile);
            });

            command.on('error', (err) => {
                console.error('\n[Video Processing Error]');
                console.error('Error message:', err.message);
                console.error('Stack trace:', err.stack);
                reject(err);
            });

            // Run command
            command.save(outputFile);
        });
    } catch (error) {
        console.error('[Critical Error]', error);
        throw error;
    }
}

async function processAllVideos() {
    await resolveEncoder();
    try {
        const videosDir = path.join(__dirname, 'videos');
        await fs.ensureDir(videosDir);

        const files = await fs.readdir(videosDir);
        const videoFiles = files.filter(file => 
            ['.mp4', '.avi', '.mov', '.mkv'].includes(path.extname(file).toLowerCase())
        );

        console.log(`Found ${videoFiles.length} video files.`);

        for (const file of videoFiles) {
            const inputPath = path.join(videosDir, file);
            console.log(`Processing: ${file}`);
            try {
                const outputPath = await processVideo(inputPath);
                console.log(`Processing completed: ${path.basename(outputPath)}`);
            } catch (err) {
                console.error(`Error: Problem processing ${file}:`, err);
            }
        }
    } catch (err) {
        console.error('An error occurred:', err);
    }
}

// Start the application
processAllVideos(); 