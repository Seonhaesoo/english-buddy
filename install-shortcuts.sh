#!/data/data/com.termux/files/usr/bin/bash
# Termux 에서 실행: 홈 화면 아이콘용 스크립트 설치 (Termux:Widget 필요)
set -e
mkdir -p ~/.shortcuts/tasks
proot-distro login debian -- bash -c 'cat ~/english-tutor/shortcuts/"English Buddy"' > ~/.shortcuts/tasks/"English Buddy"
proot-distro login debian -- bash -c 'cat ~/english-tutor/shortcuts/"English Buddy 끄기"' > ~/.shortcuts/tasks/"English Buddy 끄기"
chmod +x ~/.shortcuts/tasks/*
echo "아이콘 스크립트 설치 완료"

# Termux 를 열면(앱의 "서버 켜기" 버튼) 서버가 꺼져 있을 때 자동으로 켜고 앱으로 돌아가기
MARK="# english-buddy autostart"
if ! grep -q "$MARK" ~/.bashrc 2>/dev/null; then
  cat >> ~/.bashrc <<'EOS'
# english-buddy autostart
if ! curl -s -m 1 http://localhost:8787/api/status >/dev/null 2>&1; then
  echo "English Buddy 켜는 중... (취소하려면 Ctrl+C)"
  sleep 1 && bash "$HOME/.shortcuts/tasks/English Buddy"
fi
EOS
  echo "자동 시작 설정 완료"
fi
