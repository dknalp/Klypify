#!/bin/bash
set -e
echo "Pulling latest changes..."
git pull
echo "Updating dependencies..."
bun install
echo "Done! Run ./start.sh to launch."
