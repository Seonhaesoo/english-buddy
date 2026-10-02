#!/data/data/com.termux/files/usr/bin/bash
# Termux 에서 한 번만 실행: Debian(proot) 설치 + 앱 설치
# 사용법: bash termux-setup.sh <git 저장소 주소>
set -e
REPO="$1"
if [ -z "$REPO" ]; then echo "사용법: bash termux-setup.sh <git 저장소 주소>"; exit 1; fi

echo "== 1/4 Termux 패키지 설치 =="
export DEBIAN_FRONTEND=noninteractive
OPTS="-o Dpkg::Options::=--force-confnew -o Dpkg::Options::=--force-confdef"
pkg update -y $OPTS && pkg upgrade -y $OPTS
pkg install -y $OPTS proot-distro

echo "== 2/4 Debian 설치 (몇 분 걸려요) =="
proot-distro install debian 2>/dev/null || echo "(Debian 이미 설치됨)"

echo "== 3/4 Debian 안에 Node.js, git, 앱 설치 =="
proot-distro login debian -- bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive; apt update && apt install -y nodejs npm git nano ca-certificates
  cd ~
  if [ -d english-tutor ]; then cd english-tutor && git pull; else git clone '$REPO' english-tutor && cd english-tutor; fi
  npm install --omit=dev
  [ -f .env ] || cp .env.example .env
"

echo "== 4/4 실행 스크립트 만들기 =="
cat > ~/tutor.sh <<'EOS'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
proot-distro login debian -- bash -c "cd ~/english-tutor && node server.js"
EOS
chmod +x ~/tutor.sh

echo
echo "설치 완료!"
echo "다음: 토큰 넣기 →  proot-distro login debian -- nano /root/english-tutor/.env"
echo "실행:            ~/tutor.sh"
