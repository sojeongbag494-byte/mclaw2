# MCLAW Backend — 배포 가이드

## 새 아키텍처: 서버가 진짜 리눅스 컴퓨터

```
[브라우저]  index.html (Phase 2에서 수정)
   │
   │ 1. Supabase Auth 로그인 → JWT
   │ 2. POST /api/chat (Groq 프록시)
   │ 3. Groq가 tool_call 반환하면 → POST /api/ws/{tool}
   ▼
[Render Docker 컨테이너]  server.js
   ├─ /api/chat        Groq 프록시 + 대기열
   ├─ /api/ws/bash     ← 진짜 bash 실행 🔥
   ├─ /api/ws/write    ← 진짜 파일 쓰기 🔥
   ├─ /api/ws/read     ← 진짜 파일 읽기 🔥
   ├─ /api/ws/edit     ← 부분 편집
   ├─ /api/ws/list     ← 파일 목록
   ├─ /api/ws/download ← 워크스페이스 zip
   ├─ /preview/:uid/*  ← 정적 파일 서빙
   └─ /api/conversations  대화 저장 (Supabase)
   │
   │ 사용자별 격리:
   │ /tmp/mclaw_workspaces/{user_id}/
   ▼
[Groq API] + [Supabase DB]
```

**핵심**: AI가 만든 파일은 **서버 위에 실제로 존재**함. bash 명령도 진짜 실행됨.
Node.js 프로젝트 만들면 `npm install`도 가능. Python 스크립트도 실행됨.

---

## 1. Supabase 세팅

1. https://supabase.com → 새 프로젝트 (Region: Seoul)
2. **SQL Editor → New query** → `schema.sql` 붙여넣고 Run
3. **Settings → API** 에서:
   - `Project URL` → `SUPABASE_URL`
   - `service_role secret` → `SUPABASE_SERVICE_KEY` ⚠️ 서버 전용
   - `anon public` → 프론트엔드에서 사용
4. **Authentication → Providers**: Email 활성 (기본), Confirm email 개발 중엔 꺼두면 편함

---

## 2. GitHub에 올리기

`mclaw-backend.zip`을 압축 풀면 나오는 파일들:
- `server.js`
- `package.json`
- `Dockerfile`
- `render.yaml`
- `schema.sql`
- `.env.example`
- `.gitignore`
- `DEPLOY.md`

**GitHub 새 저장소 만들고**:
1. https://github.com/new → 저장소 생성 (예: `mclaw-backend`)
2. 로컬에서 zip 풀고:
   ```
   git init
   git add .
   git commit -m "initial"
   git branch -M main
   git remote add origin https://github.com/{USERNAME}/mclaw-backend.git
   git push -u origin main
   ```

또는 **GitHub 웹 UI**에서 파일들 드래그해서 업로드해도 됨.

---

## 3. Render 배포

### 방법 A: render.yaml 자동 (추천)
1. https://render.com → **New +** → **Blueprint**
2. GitHub 저장소 연결
3. render.yaml 자동 감지 → 환경변수만 채우기:
   - `GROQ_KEYS` = `gsk_xxx,gsk_yyy,gsk_zzz`
   - `SUPABASE_URL` = `https://xxx.supabase.co`
   - `SUPABASE_SERVICE_KEY` = `eyJhbG...`
4. Apply → 자동 배포

### 방법 B: 수동
1. **New Web Service** → GitHub 연결
2. Runtime: **Docker** (자동 감지)
3. Environment Variables:
   ```
   GROQ_KEYS=gsk_xxx,gsk_yyy
   SUPABASE_URL=https://xxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJhbG...
   MAX_CONCURRENT=3
   FRONTEND_ORIGINS=*
   ```
4. Create Web Service

### 배포 확인
- `https://mclaw-backend.onrender.com/` → 홈페이지
- `/health` → 키 개수, 워크스페이스 상태

---

## 4. 각 도구 API 사용 예

### bash 실행 (AI가 사용할 핵심)
```bash
curl -X POST https://mclaw-backend.onrender.com/api/ws/bash \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"command": "mkdir myproj && cd myproj && npm init -y && ls -la"}'
```

응답:
```json
{
  "ok": true,
  "exit_code": 0,
  "stdout": "Wrote to package.json:\n...\ntotal 12\ndrwx...",
  "stderr": "",
  "message": "[exit 0]\n..."
}
```

### 파일 쓰기
```bash
curl -X POST /api/ws/write \
  -d '{"path": "index.html", "content": "<html>..."}'
```

### 미리보기
브라우저에서:
```
https://mclaw-backend.onrender.com/preview/{user_id}/index.html?token={JWT}
```

### 워크스페이스 zip 다운로드
```
GET /api/ws/download → mclaw-{timestamp}.zip
```

---

## 5. AI 에이전트가 사용할 도구 매핑

Phase 2에서 프론트엔드가 이렇게 매핑:

| Groq tool_call | 서버 엔드포인트 |
|---|---|
| `bash({command})` | `POST /api/ws/bash` |
| `create_file({path, content})` | `POST /api/ws/write` |
| `edit_file({path, old_str, new_str})` | `POST /api/ws/edit` |
| `read_file({path})` | `POST /api/ws/read` |
| `list_files()` | `GET /api/ws/list` |
| `delete_file({path})` | `POST /api/ws/delete` |
| `preview_html({path})` | iframe src = `/preview/:uid/{path}` |
| `validate_html({path})` | 프론트에서 iframe으로 (동일) |

이제 AI가 정말로:
- `npm install express` 실행
- `python3 -c "print('hi')"` 실행
- `git init && git commit` 실행
- `curl https://api...` 로 외부 API 호출
- 여러 파일 만들고 서로 참조

모두 서버 위에서 **진짜로** 됨.

---

## 6. 보안 필터

bash 명령에 대해 다음 패턴 자동 차단:
- `sudo`, `su -`
- `chmod`, `chown` 시스템 파일
- `rm -rf /` (workspace 밖)
- `mkfs`, `dd if=`
- `/etc/passwd` 등 민감 파일
- fork bomb
- `curl ... | sh` (임의 스크립트 실행)

Workspace는 `/tmp/mclaw_workspaces/{user_id}/` 로 격리.
경로 감옥: `../` 로 위 디렉토리 접근 시도 차단.
Timeout: bash 명령 30초. 출력 30KB 제한.

---

## 7. Free tier 한계

- **Render Free**: 15분 무활동시 슬립 → 첫 요청 30초 지연
- **디스크**: `/tmp`는 영구적 아님 → 서버 재시작 시 워크스페이스 삭제
  - 대화 히스토리는 Supabase에 있어서 안전
  - 파일도 필요하면 대화별로 Supabase `conversations.files` 컬럼에 백업 가능

프로덕션이면:
- Render Starter ($7/월) → 슬립 없음, 디스크 지속
- 또는 Fly.io 볼륨 마운트

---

## 8. 문제 해결

| 증상 | 해결 |
|---|---|
| `zip: command not found` | Dockerfile에서 zip 설치 확인, 재배포 |
| bash 명령 timeout | 30초 넘게 실행되면 킬됨. 백그라운드 작업 X |
| CORS 에러 | `FRONTEND_ORIGINS=*` 확인 |
| 401 Unauthorized | 프론트가 JWT 안 붙임 or 토큰 만료 |
| 파일 사라짐 | Free tier 슬립/재시작 문제. Starter 티어로 |

---

## 9. 다음 단계

Phase 2: 프론트엔드(`index.html`) 대공사
- 로그인/회원가입 모달
- 자체 API 키 등록 대신 서버 URL 등록
- 도구 실행을 서버 `/api/ws/*` 로 라우팅
- 대화를 Supabase에 저장
- 미리보기 iframe 서버 URL 사용

준비되면 이어서 진행!
