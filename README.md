# English Buddy — 나만의 영어 회화 선생님

안드로이드 폰 하나로 돌아가는 음성 영어 회화 앱. Claude **구독**으로 동작(API 요금 없음).

```
폰 크롬(PWA: 듣기/말하기)  ⇄  localhost:8787 서버(Termux 안 Debian)  ⇄  Claude(구독 토큰)
```

## 1. PC에서 토큰 만들기 (한 번)
터미널에서 실행 → 브라우저로 로그인 → 나오는 토큰(`sk-ant-oat...`)을 복사해 둡니다.
```bash
claude setup-token
```
> 이 토큰은 비밀번호와 같아요. git에 올리거나 남에게 주지 마세요.

## 2. 폰 설치 (한 번, 약 20분)
1. **Termux** 설치 — Play 스토어 말고 **F-Droid** 버전 (https://f-droid.org/packages/com.termux/)
2. Termux 실행 후:
   ```bash
   pkg install -y git
   git clone <이 저장소 주소> setup && bash setup/termux-setup.sh <이 저장소 주소>
   ```
3. 토큰 넣기:
   ```bash
   proot-distro login debian -- nano /root/english-tutor/.env
   ```
   `CLAUDE_CODE_OAUTH_TOKEN=` 뒤에 토큰 붙여넣기 → `Ctrl+O` 엔터 → `Ctrl+X`
4. 안드로이드 설정 → 앱 → Termux → 배터리 → **제한 없음** (안 하면 서버가 꺼져요)

## 3. 앱 아이콘 만들기 (한 번)
1. Termux에서 아래 명령 → 서버가 켜지고 앱 화면이 열림
   ```bash
   proot-distro login debian -- cat /root/english-tutor/install-shortcuts.sh | bash && bash "$HOME/.shortcuts/tasks/English Buddy"
   ```
2. 크롬 메뉴 ⋮ → **홈 화면에 추가** (또는 "앱 설치")

## 4. 매일 쓰기
- 홈 화면 **English** 아이콘 탭 → 큰 동그라미 탭 → 선생님이 말을 걸어요
- 서버는 계속 켜져 있지만, Claude는 대화할 때만 돌아요 (15분 쉬면 자동으로 쉼 → 배터리 거의 안 씀)
- 폰을 재부팅했거나 "서버 꺼짐"이 보이면: 동그라미 탭 → Termux가 열리면서 자동으로 켜짐

| 화면 | 의미 |
|---|---|
| 🟢 초록 | 듣는 중 — 영어로 말하세요 |
| 🟠 주황 | 생각 중 |
| 🔵 파랑 | 말하는 중 — 탭하면 끊고 바로 내 차례 |

- 🐢 **천천히 다시**: 마지막 말을 느리게 다시
- 🇰🇷 **한국어로**: 막힐 때 한 번 한국어로 말하기 ("이거 영어로 뭐라고 해?")
- ⏸ **일시정지** / ↺ **새 대화**
- 말로도 가능: "slower", "천천히", "I don't understand"

## 운전할 때
- 출발 전에 켜두고 거치대에 꽂기, 충전기 연결 (화면은 자동으로 안 꺼져요)
- 대화는 손 안 대고 자동으로 이어집니다. 1분쯤 조용하면 쉬어요(탭해서 재개)
- **운전 중엔 화면 조작하지 마세요.**

## 업데이트
```bash
proot-distro login debian -- bash -c "cd ~/english-tutor && git pull && npm install"
```

## 문제 해결
- **"로그인 토큰 문제"** → `.env` 토큰 확인, 만료됐으면 PC에서 `claude setup-token` 다시
- **"서버 꺼짐"** → Termux에서 `~/tutor.sh`
- **마이크 안 됨** → 크롬 주소창 자물쇠 → 권한 → 마이크 허용
- **너무 빠르다/어렵다** → 아래 속도 슬라이더, 또는 "slower" 라고 말하기
