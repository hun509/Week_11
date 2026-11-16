from __future__ import annotations

import os
import time
import uuid
from flask import Flask, jsonify, request

app = Flask(__name__)

# 기본 제공 트랙 목록 (AWS S3 업로드 후 S3 객체 URL로 바로 교체하거나 UI에서 직접 S3 URL 입력 가능)
DEFAULT_TRACKS = [
    {
        "id": "track-1",
        "title": "Sunset Arcade Drive (Synthwave Loop)",
        "artist": "Cloud DJ Sample",
        "duration_sec": 30,
        "url": "/samples/sample_track_1.wav",
        "source": "기본 내장 음원 (S3 URL로 변경 가능)",
    },
    {
        "id": "track-2",
        "title": "Midnight Lo-Fi Coding Beats",
        "artist": "KDU Studio",
        "duration_sec": 30,
        "url": "/samples/sample_track_2.wav",
        "source": "기본 내장 음원 (S3 URL로 변경 가능)",
    },
]

# 인메모리 리스닝 룸 저장소
ROOMS: dict[str, dict] = {}


def _calc_current_position(room: dict) -> float:
    """방의 재생 상태(is_playing, started_at, paused_position)를 기준으로 현재 동기화 재생 시점(초)을 계산합니다."""
    duration = float(room.get("duration_sec") or 30.0)
    if not room.get("is_playing", False):
        return round(min(float(room.get("paused_position", 0.0)), duration), 2)
    elapsed = max(0.0, time.time() - float(room.get("started_at", time.time())))
    if duration > 0:
        return round(elapsed % duration, 2)
    return round(elapsed, 2)


def _seed_initial_room() -> None:
    now = time.time()
    room_id = "room-kdu-01"
    ROOMS[room_id] = {
        "room_id": room_id,
        "title": "밤 10시 코딩 & 게임 브금 같이 듣기방",
        "host": "DJ정훈",
        "max_listeners": 50,
        "listeners": ["DJ정훈", "게스트1"],
        "track_title": DEFAULT_TRACKS[0]["title"],
        "track_artist": DEFAULT_TRACKS[0]["artist"],
        "audio_url": DEFAULT_TRACKS[0]["url"],
        "duration_sec": DEFAULT_TRACKS[0]["duration_sec"],
        "is_playing": True,
        "started_at": now,
        "paused_position": 0.0,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "comments": [
            {
                "id": "c-1",
                "nickname": "DJ정훈",
                "message": "오디오 동기화 버튼을 누르면 현재 재생 시점으로 즉시 맞춰집니다!",
                "track_timestamp_sec": 0.0,
                "created_at": time.strftime("%H:%M:%S"),
            }
        ],
    }


_seed_initial_room()


@app.get("/api/health")
def health():
    return jsonify(
        status="ok",
        service="syncbeat-dj-listening-room",
        active_rooms=len(ROOMS),
    )


@app.get("/api/tracks")
def list_tracks():
    return jsonify(items=DEFAULT_TRACKS, count=len(DEFAULT_TRACKS))


@app.get("/api/rooms")
def list_rooms():
    q = (request.args.get("q") or "").strip().casefold()
    items = []
    for room in ROOMS.values():
        if q and q not in room["title"].casefold() and q not in room["host"].casefold():
            continue
        items.append(
            {
                "room_id": room["room_id"],
                "title": room["title"],
                "host": room["host"],
                "listener_count": len(room["listeners"]),
                "max_listeners": room["max_listeners"],
                "track_title": room["track_title"],
                "track_artist": room["track_artist"],
                "is_playing": room["is_playing"],
                "current_position_sec": _calc_current_position(room),
                "comment_count": len(room["comments"]),
            }
        )
    return jsonify(items=items, count=len(items))


@app.post("/api/rooms")
def create_room():
    """
    [기능 1] 리스닝 룸 생성
    - 정상: 방 제목(1~40자), 호스트 닉네임(1~20자), 최대 정원(2~200명)
    - 실패/경계: 빈 제목, 40자 초과 제목, 정원 범위(2~200) 벗어남 -> 400 반환
    """
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    host = (data.get("host") or "").strip()
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
        "max_listeners": max_listeners,
        "listeners": [host],
        "track_title": DEFAULT_TRACKS[0]["title"],
        "track_artist": DEFAULT_TRACKS[0]["artist"],
        "audio_url": DEFAULT_TRACKS[0]["url"],
        "duration_sec": DEFAULT_TRACKS[0]["duration_sec"],
        "is_playing": True,
        "started_at": now,
        "paused_position": 0.0,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "comments": [],
    }
    ROOMS[room_id] = room
    return jsonify(
        message="리스닝 룸이 생성되었습니다.",
        room_id=room_id,
        title=room["title"],
        host=room["host"],
        max_listeners=room["max_listeners"],
    ), 201


@app.get("/api/rooms/<room_id>")
def get_room(room_id: str):
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    nickname = (request.args.get("nickname") or "").strip()
    if nickname and len(nickname) <= 20 and nickname not in room["listeners"]:
        if len(room["listeners"]) >= room["max_listeners"]:
            return jsonify(error="방 정원이 가득 차서 입장할 수 없습니다."), 409
        room["listeners"].append(nickname)

    return jsonify(
        room_id=room["room_id"],
        title=room["title"],
        host=room["host"],
        listeners=room["listeners"],
        listener_count=len(room["listeners"]),
        max_listeners=room["max_listeners"],
        track_title=room["track_title"],
        track_artist=room["track_artist"],
        audio_url=room["audio_url"],
        duration_sec=room["duration_sec"],
        is_playing=room["is_playing"],
        current_position_sec=_calc_current_position(room),
        server_time=round(time.time(), 2),
        comments=room["comments"][-50:],
    )


@app.post("/api/rooms/<room_id>/playback")
def update_playback(room_id: str):
    """
    [기능 2] DJ 선곡(AWS S3 오디오 URL 또는 샘플 트랙) 및 재생 시점 동기화 제어
    - 정상: 유효한 오디오 경로(/samples/... 또는 http/https S3 URL)와 0~3600초 내 탐색 위치 설정
    - 실패/경계: 잘못된 URL 형식, 음수 재생 위치(-1초 등), 3600초 초과 위치 -> 400 반환
    """
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    data = request.get_json(silent=True) or {}
    track_title = (data.get("track_title") or room["track_title"]).strip()
    track_artist = (data.get("track_artist") or room["track_artist"]).strip()
    audio_url = (data.get("audio_url") or room["audio_url"]).strip()
    action = (data.get("action") or "sync").strip().lower()
    seek_sec = data.get("seek_sec", 0.0)
    duration_sec = data.get("duration_sec", room["duration_sec"])

    if not audio_url or not (
        audio_url.startswith("http://")
        or audio_url.startswith("https://")
        or audio_url.startswith("/samples/")
    ):
        return jsonify(
            error="오디오 주소는 http://, https:// (S3 객체 URL) 또는 /samples/ 경로여야 합니다."
        ), 400

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

    return jsonify(
        message="DJ 선곡 및 재생 동기화 상태가 업데이트되었습니다.",
        room_id=room_id,
        track_title=room["track_title"],
        audio_url=room["audio_url"],
        is_playing=room["is_playing"],
        current_position_sec=_calc_current_position(room),
        server_time=round(now, 2),
    )


@app.post("/api/rooms/<room_id>/comments")
def add_comment(room_id: str):
    """
    [기능 3] 실시간 감상 댓글(타임스탬프 채팅) 작성 및 공유
    - 정상: 닉네임(1~20자), 댓글 내용(1~200자) 입력 시 현재 곡 재생 시점(초)과 함께 저장
    - 실패/경계: 빈 댓글 내용, 200자 초과 댓글, 빈 닉네임 -> 400 반환
    """
    room = ROOMS.get(room_id)
    if not room:
        return jsonify(error="존재하지 않는 리스닝 룸입니다."), 404

    data = request.get_json(silent=True) or {}
    nickname = (data.get("nickname") or "").strip()
    message = (data.get("message") or "").strip()

    if not nickname:
        return jsonify(error="닉네임을 입력하세요."), 400
    if len(nickname) > 20:
        return jsonify(error="닉네임은 20자 이내로 입력하세요."), 400
    if not message:
        return jsonify(error="댓글 내용을 입력하세요."), 400
    if len(message) > 200:
        return jsonify(error="댓글은 200자 이내로 입력하세요."), 400

    if nickname not in room["listeners"] and len(room["listeners"]) < room["max_listeners"]:
        room["listeners"].append(nickname)

    comment_item = {
        "id": f"c-{len(room['comments']) + 1}",
        "nickname": nickname,
        "message": message,
        "track_timestamp_sec": _calc_current_position(room),
        "created_at": time.strftime("%H:%M:%S"),
    }
    room["comments"].append(comment_item)

    return jsonify(
        message="댓글이 등록되었습니다.",
        comment=comment_item,
        total_comments=len(room["comments"]),
    ), 201


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=False)
