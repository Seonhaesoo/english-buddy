#!/data/data/com.termux/files/usr/bin/bash
# Termux 에서 실행: 홈 화면 아이콘용 스크립트 설치 (Termux:Widget 필요)
set -e
mkdir -p ~/.shortcuts/tasks
proot-distro login debian -- bash -c 'cat ~/english-tutor/shortcuts/"English Buddy"' > ~/.shortcuts/tasks/"English Buddy"
proot-distro login debian -- bash -c 'cat ~/english-tutor/shortcuts/"English Buddy 끄기"' > ~/.shortcuts/tasks/"English Buddy 끄기"
chmod +x ~/.shortcuts/tasks/*
echo "아이콘 스크립트 설치 완료"
