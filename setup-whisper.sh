#!/bin/bash
# Debian(proot) 안에서 실행: Whisper(무료 음성 인식) 설치. 10~20분 걸려요.
set -e
export DEBIAN_FRONTEND=noninteractive
apt update && apt install -y build-essential cmake ffmpeg git curl
cd ~
[ -d whisper.cpp ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build build -j4 --config Release --target whisper-cli
[ -f models/ggml-base.bin ] || bash ./models/download-ggml-model.sh base
ls -la build/bin/whisper-cli models/ggml-base.bin
echo WHISPER_OK
