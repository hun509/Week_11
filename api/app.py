from __future__ import annotations

import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError
from flask import Flask, jsonify, request
from flask_socketio import SocketIO, emit, join_room as sio_join_room, leave_room as sio_leave_room
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 최대 30MB 음원 업로드 허용

socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

KST = timezone(timedelta(hours=9))
S3_BUCKET = os.environ.get("S3_BUCKET", "kdu-2124066-11week").strip() or "kdu-2124066-11week"
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2").strip() or "ap-southeast-2"
AUDIO_EXTENSIONS = (".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac")
SESSION_TIMEOUT_SEC = 15.0

DEFAULT_TRACKS = [
    {
        "id": "local-1",
        "title": "Sunset Arcade Drive (내장 샘플 1)",
        "artist": "Cloud DJ Sample",
        "duration_sec": 16,
        "url": "/samples/sample_track_1.wav",
        "source": "내장 샘플",
    },
    {
        "id": "local-2",
        "title": "Midnight Lo-Fi Coding Beats (내장 샘플 2)",
        "artist": "KDU Studio",
        "duration_sec": 16,
        "url": "/samples/sample_track_2.wav",
        "source": "내장 샘플",
    },
]

ROOMS: dict[str, dict] = {}


def _now_kst_str() -> str:
    return datetime.now(KST).strftime("%H:%M:%S")


def _prune_inactive_listeners(room: dict) -> None:
    now = time.time()
    sessions: dict[str, dict] = room.setdefault("sessions", {})
    expired = [
        sid
        for sid, info in sessions.items()
        if now - float(info.get("last_seen", 0.0)) > SESSION_TIMEOUT_SEC
    ]
    for sid in expired:
        sessions.pop(sid, None)


def _calc_current_position(room: dict) -> float:
    duration = float(room.get("duration_sec") or 16.0)
    if not room.get("is_playing", False):
        return round(min(float(room.get("paused_position", 0.0)), duration), 2)
    elapsed = max(0.0, time.time() - float(room.get("started_at", time.time())))
    if duration > 0:
        return round(elapsed % duration, 2)
    return round(elapsed, 2)


def _room_snapshot(room: dict, session_id: str = "", sort_by: str = "real_time") -> dict:
    _prune_inactive_listeners(room)
    comments = list(room["comments"])
    if sort_by == "track_time":
        comments.sort(
            key=lambda c: (
                float(c.get("track_timestamp_sec", 0.0)),
                float(c.get("created_at_epoch", 0.0)),
            )
        )
    else:
        comments.sort(key=lambda c: float(c.get("created_at_epoch", 0.0)))

    listeners_info = [
        {"nickname": v["nickname"], "role": v["role"]}
        for v in room["sessions"].values()
    ]

    return {
        "room_id": room["room_id"],
        "title": room["title"],
        "host": room["host"],
        "is_host": (session_id == room["host_session_id"]),
        "listeners": listeners_info,
        "listener_count": len(listeners_info),
        "max_listeners": room["max_listeners"],
        "track_title": room["track_title"],
        "track_artist": room["track_artist"],
        "audio_url": room["audio_url"],
        "duration_sec": room["duration_sec"],
        "is_playing": room["is_playing"],
        "current_position_sec": _calc_current_position(room),
        "server_time": round(time.time(), 2),
        "comments": comments[-100:],
    }


def _seed_initial_room() -> None:
    now = time.time()
    room_id = "room-kdu-01"
    ROOMS[room_id] = {
        "room_id": room_id,
        "title": "밤 10시 코딩 & 게임 브금 같이 듣기방",
        "host": "DJ정훈",
        "host_session_id": "seed-host",
        "max_listeners": 50,
        "sessions": {},
        "track_title": DEFAULT_TRACKS[0]["title"],
        "track_artist": DEFAULT_TRACKS[0]["artist"],
        "audio_url": DEFAULT_TRACKS[0]["url"],
        "duration_sec": DEFAULT_TRACKS[0]["duration_sec"],
        "is_playing": True,
        "started_at": now,
        "paused_position": 0.0,
        "created_at": _now_kst_str(),
        "comments": [
            {
                "id": "c-1",
                "nickname": "시스템",
                "role": "system",
                "message": "실시간 WebSocket 채팅방이 열렸습니다! 호스트가 방을 만들거나 게스트로 입장해 보세요.",
                "track_timestamp_sec": 0.0,
                "created_at_epoch": now,
                "created_at": _now_kst_str(),
            }
        ],
    }


_seed_initial_room()


@app.get("/api/health")
def health():
    return jsonify(
        status="ok",
        service="syncbeat-dj-listening-room",
        s3_bucket=S3_BUCKET,
        aws_region=AWS_REGION,
        active_rooms=len(ROOMS),
    )


@app.get("/api/s3/tracks")
def list_s3_tracks():
    """고정된 S3 버킷(kdu-2124066-11week, ap-southeast-2)에서 오디오 파일 목록을 조회합니다."""
    s3_items: list[dict] = []
    s3_status = "S3 연결 대기"
    s3_error = None

    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, MaxKeys=100)
        for obj in resp.get("Contents", []):
            key = obj.get("Key", "")
            if key.lower().endswith(AUDIO_EXTENSIONS):
                encoded_key = quote(key, safe="/")
                s3_url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{encoded_key}"
                s3_items.append(
                    {
                        "id": f"s3-{key}",
                        "title": os.path.basename(key),
                        "artist": "AWS S3 음원",
                        "duration_sec": 180,
                        "url": s3_url,
                        "source": "AWS S3",
                        "size_kb": round(obj.get("Size", 0) / 1024, 1),
                    }
                )
        s3_status = f"S3 연결됨 ({len(s3_items)}개 음원)"
    except (NoCredentialsError, ClientError, BotoCoreError) as exc:
        s3_status = "S3 목록 조회 실패 (IAM 권한 또는 버킷 확인)"
        s3_error = str(exc)

    return jsonify(
        s3_status=s3_status,
        s3_error=s3_error,
        s3_tracks=s3_items,
        default_tracks=DEFAULT_TRACKS,
        items=s3_items + DEFAULT_TRACKS,
    )


@app.post("/api/s3/upload")
def upload_s3_track():
    """[기능 2 확장 - 호스트 전용] 호스트가 직접 오디오 파일을 S3 버킷에 업로드합니다."""
    room_id = (request.form.get("room_id") or "").strip()
    session_id = (request.form.get("session_id") or "").strip()

    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404
    if session_id != room["host_session_id"]:
        return jsonify(error="호스트(DJ)만 음원을 업로드할 수 있습니다."), 403

    if "file" not in request.files:
        return jsonify(error="업로드할 오디오 파일을 선택하세요."), 400

    file = request.files["file"]
    if not file or not file.filename:
        return jsonify(error="선택된 파일이 없습니다."), 400

    raw_name = file.filename
    ext = os.path.splitext(raw_name)[1].lower()
    if ext not in AUDIO_EXTENSIONS:
        return jsonify(
            error=f"지원하지 않는 파일 형식입니다. ({', '.join(AUDIO_EXTENSIONS)} 파일만 가능)"
        ), 400

    safe_base = secure_filename(os.path.splitext(raw_name)[0]) or "track"
    s3_key = f"uploads/{int(time.time())}_{safe_base}{ext}"

    content_type_map = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".flac": "audio/flac",
    }

    try:
        s3 = boto3.client("s3", region_name=AWS_REGION)
        s3.upload_fileobj(
            file.stream,
            S3_BUCKET,
            s3_key,
            ExtraArgs={"ContentType": content_type_map.get(ext, "application/octet-stream")},
        )
        s3_url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{quote(s3_key, safe='/')}"
        return jsonify(
            message=f"'{raw_name}' 파일이 S3에 업로드되었습니다!",
            url=s3_url,
            title=os.path.splitext(raw_name)[0],
            key=s3_key,
        ), 201
    except (NoCredentialsError, ClientError, BotoCoreError) as exc:
        return jsonify(
            error=f"S3 업로드 실패: IAM 역할(week8-role)에 S3 쓰기 권한(AmazonS3FullAccess 등)이 있는지 확인하세요. ({exc})"
        ), 500


@app.get("/api/rooms")
def list_rooms():
    items = []
    for room in ROOMS.values():
        _prune_inactive_listeners(room)
        items.append(
            {
                "room_id": room["room_id"],
                "title": room["title"],
                "host": room["host"],
                "listener_count": len(room["sessions"]),
                "max_listeners": room["max_listeners"],
                "track_title": room["track_title"],
                "is_playing": room["is_playing"],
                "comment_count": len(room["comments"]),
            }
        )
    return jsonify(items=items, count=len(items))


@app.post("/api/rooms")
def create_room():
    """[기능 1 - 호스트] 리스닝 룸 생성"""
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    host = (data.get("host") or "").strip()
    session_id = (data.get("session_id") or "").strip() or uuid.uuid4().hex
    max_listeners = data.get("max_listeners", 30)

    if not title:
        return jsonify(error="방 제목을 입력하세요."), 400
    if len(title) > 40:
        return jsonify(error="방 제목은 40자 이내로 입력하세요."), 400
    if not host:
        return jsonify(error="호스트(DJ) 닉네임을 입력하세요."), 400
    if len(host) > 20:
        return jsonify(error="호스트 닉네임은 20자 이내로 입력하세요."), 400

    try:
        max_listeners = int(max_listeners)
    except (TypeError, ValueError):
        return jsonify(error="최대 정원은 숫자로 입력해야 합니다."), 400

    if max_listeners < 2 or max_listeners > 200:
        return jsonify(error="최대 정원은 2명 이상 200명 이하로 설정하세요."), 400

    room_id = f"room-{uuid.uuid4().hex[:6]}"
    now = time.time()
    room = {
        "room_id": room_id,
        "title": title,
        "host": host,
        "host_session_id": session_id,
        "max_listeners": max_listeners,
        "sessions": {
            session_id: {"nickname": host, "role": "host", "last_seen": now}
        },
        "track_title": DEFAULT_TRACKS[0]["title"],
        "track_artist": DEFAULT_TRACKS[0]["artist"],
        "audio_url": DEFAULT_TRACKS[0]["url"],
        "duration_sec": DEFAULT_TRACKS[0]["duration_sec"],
        "is_playing": True,
        "started_at": now,
        "paused_position": 0.0,
        "created_at": _now_kst_str(),
        "comments": [
            {
                "id": "c-init",
                "nickname": "시스템",
                "role": "system",
                "message": f"{host}님이 '{title}' 리스닝 룸을 열었습니다.",
                "track_timestamp_sec": 0.0,
                "created_at_epoch": now,
                "created_at": _now_kst_str(),
            }
        ],
    }
    ROOMS[room_id] = room
    return jsonify(
        message="호스트 리스닝 룸이 생성되었습니다.",
        room_id=room_id,
        title=room["title"],
        host=room["host"],
        max_listeners=room["max_listeners"],
        host_session_id=session_id,
    ), 201


@app.post("/api/rooms/<room_id>/join")
def join_room_api(room_id: str):
    """[기능 1 - 게스트] 선택한 리스닝 룸 입장"""
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    _prune_inactive_listeners(room)
    data = request.get_json(silent=True) or {}
    nickname = (data.get("nickname") or "").strip()
    session_id = (data.get("session_id") or "").strip() or uuid.uuid4().hex

    if not nickname:
        return jsonify(error="게스트 닉네임을 입력하세요."), 400
    if len(nickname) > 20:
        return jsonify(error="닉네임은 20자 이내로 입력하세요."), 400

    sessions = room["sessions"]
    if session_id not in sessions and len(sessions) >= room["max_listeners"]:
        return jsonify(error="방 정원이 가득 차서 입장할 수 없습니다."), 409

    is_new_join = session_id not in sessions
    role = "host" if session_id == room["host_session_id"] else "guest"
    sessions[session_id] = {
        "nickname": nickname,
        "role": role,
        "last_seen": time.time(),
    }

    if is_new_join:
        now = time.time()
        sys_msg = {
            "id": f"c-{len(room['comments']) + 1}",
            "nickname": "시스템",
            "role": "system",
            "message": f"🙋 {nickname}님이 입장했습니다.",
            "track_timestamp_sec": _calc_current_position(room),
            "created_at_epoch": now,
            "created_at": _now_kst_str(),
        }
        room["comments"].append(sys_msg)
        socketio.emit("chat_message", {"room_id": room_id, "comment": sys_msg}, to=room_id)
        socketio.emit("room_updated", _room_snapshot(room, ""), to=room_id)

    return jsonify(
        message=f"'{room['title']}' 방에 입장했습니다.",
        room_id=room_id,
        role=role,
        nickname=nickname,
        listener_count=len(sessions),
    )


@app.post("/api/rooms/<room_id>/leave")
def leave_room_api(room_id: str):
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(ok=True)
    data = request.get_json(silent=True) or {}
    session_id = (data.get("session_id") or "").strip()
    if session_id and session_id in room.get("sessions", {}):
        room["sessions"].pop(session_id, None)
        socketio.emit("room_updated", _room_snapshot(room, ""), to=room_id)
    return jsonify(ok=True)


@app.get("/api/rooms/<room_id>")
def get_room(room_id: str):
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    session_id = (request.args.get("session_id") or "").strip()
    nickname = (request.args.get("nickname") or "").strip()
    role = (request.args.get("role") or "guest").strip()
    sort_by = (request.args.get("sort") or "real_time").strip()

    _prune_inactive_listeners(room)
    if session_id and nickname:
        sessions = room["sessions"]
        if session_id in sessions or len(sessions) < room["max_listeners"]:
            actual_role = "host" if session_id == room["host_session_id"] else role
            sessions[session_id] = {
                "nickname": nickname,
                "role": actual_role,
                "last_seen": time.time(),
            }

    return jsonify(_room_snapshot(room, session_id=session_id, sort_by=sort_by))


@app.post("/api/rooms/<room_id>/playback")
def update_playback(room_id: str):
    """[기능 2 - 호스트 전용] DJ 선곡 및 재생/일시정지/탐색 시점 실시간 WebSocket 브로드캐스트"""
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    data = request.get_json(silent=True) or {}
    session_id = (data.get("session_id") or "").strip()

    if session_id != room["host_session_id"]:
        return jsonify(error="호스트(DJ)만 이 방의 음악과 재생 상태를 제어할 수 있습니다."), 403

    track_title = (data.get("track_title") or room["track_title"]).strip()
    track_artist = (data.get("track_artist") or room["track_artist"]).strip()
    audio_url = (data.get("audio_url") or room["audio_url"]).strip()
    action = (data.get("action") or "play").strip().lower()
    seek_sec = data.get("seek_sec", 0.0)
    duration_sec = data.get("duration_sec", room["duration_sec"])

    if not audio_url or not (
        audio_url.startswith("http://")
        or audio_url.startswith("https://")
        or audio_url.startswith("/samples/")
    ):
        return jsonify(error="유효한 오디오 URL 또는 샘플 경로가 필요합니다."), 400

    try:
        seek_sec = float(seek_sec)
        duration_sec = float(duration_sec)
    except (TypeError, ValueError):
        return jsonify(error="재생 위치(초)는 숫자여야 합니다."), 400

    if seek_sec < 0 or seek_sec > 3600:
        return jsonify(error="재생 위치는 0초 이상 3,600초 이하만 설정할 수 있습니다."), 400

    now = time.time()
    room["track_title"] = track_title or "Untitled Track"
    room["track_artist"] = track_artist or "DJ"
    room["audio_url"] = audio_url
    room["duration_sec"] = max(1.0, duration_sec)

    if action == "pause":
        room["is_playing"] = False
        room["paused_position"] = seek_sec
    else:
        room["is_playing"] = True
        room["started_at"] = now - seek_sec
        room["paused_position"] = seek_sec

    payload = {
        "room_id": room_id,
        "track_title": room["track_title"],
        "track_artist": room["track_artist"],
        "audio_url": room["audio_url"],
        "is_playing": room["is_playing"],
        "current_position_sec": _calc_current_position(room),
        "server_time": round(now, 2),
    }
    # WebSocket으로 방 내 모든 게스트에게 즉시 동기화 신호 전송
    socketio.emit("playback_sync", payload, to=room_id)

    return jsonify(message="재생 상태가 방 전체에 동기화되었습니다.", **payload)


@app.post("/api/rooms/<room_id>/comments")
def add_comment(room_id: str):
    """[기능 3] 실시간 WebSocket 채팅 메시지 등록 및 브로드캐스트"""
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    data = request.get_json(silent=True) or {}
    session_id = (data.get("session_id") or "").strip()
    message = (data.get("message") or "").strip()

    session_info = room.get("sessions", {}).get(session_id)
    nickname = (session_info["nickname"] if session_info else (data.get("nickname") or "")).strip()
    role = session_info["role"] if session_info else ("host" if session_id == room["host_session_id"] else "guest")

    if not nickname:
        return jsonify(error="먼저 기능 1에서 호스트 방을 생성하거나 게스트로 입장하세요."), 400
    if not message:
        return jsonify(error="채팅 내용을 입력하세요."), 400
    if len(message) > 200:
        return jsonify(error="채팅은 200자 이내로 입력하세요."), 400

    now = time.time()
    comment_item = {
        "id": f"c-{len(room['comments']) + 1}",
        "nickname": nickname,
        "role": role,
        "message": message,
        "track_timestamp_sec": _calc_current_position(room),
        "created_at_epoch": now,
        "created_at": _now_kst_str(),
    }
    room["comments"].append(comment_item)

    # WebSocket으로 방 내 모든 참여자에게 즉시 메시지 푸시
    socketio.emit("chat_message", {"room_id": room_id, "comment": comment_item}, to=room_id)

    return jsonify(
        message="채팅이 전송되었습니다.",
        comment=comment_item,
        total_comments=len(room["comments"]),
    ), 201


# --- WebSocket 이벤트 핸들러 ---
@socketio.on("join_ws_room")
def handle_join_ws_room(data):
    room_id = (data or {}).get("room_id")
    if room_id:
        sio_join_room(room_id)
        emit("ws_status", {"connected": True, "room_id": room_id})


@socketio.on("leave_ws_room")
def handle_leave_ws_room(data):
    room_id = (data or {}).get("room_id")
    if room_id:
        sio_leave_room(room_id)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
