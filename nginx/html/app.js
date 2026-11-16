let currentRoomId = "room-kdu-01";
let lastServerAudioUrl = "/samples/sample_track_1.wav";

const audioPlayer = document.getElementById("audioPlayer");
const localPosText = document.getElementById("localPosText");
const serverPosText = document.getElementById("serverPosText");
const playStateText = document.getElementById("playStateText");

function showResult(elId, message, isError = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = message;
  el.className = "result-msg " + (isError ? "err" : "ok");
}

function formatSec(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = String(Math.floor(s / 60)).padStart(2, "0");
  const r = String(s % 60).padStart(2, "0");
  return `${m}:${r}`;
}

async function checkHealth() {
  const pill = document.getElementById("healthStatus");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (res.ok && data.status === "ok") {
      pill.textContent = `API 정상 (활성 방 ${data.active_rooms}개)`;
      pill.classList.add("ok");
    } else {
      pill.textContent = "API 응답 오류";
    }
  } catch (err) {
    pill.textContent = "API 연결 실패";
  }
}

async function loadRooms() {
  const listEl = document.getElementById("roomList");
  try {
    const res = await fetch("/api/rooms");
    const data = await res.json();
    listEl.innerHTML = "";
    (data.items || []).forEach((room) => {
      const div = document.createElement("div");
      div.className = "room-item" + (room.room_id === currentRoomId ? " active" : "");
      div.innerHTML = `
        <div class="room-item-title">${room.title}</div>
        <div class="room-item-sub">
          DJ: ${room.host} · 참여 ${room.listener_count}/${room.max_listeners}명 · 🎵 ${room.track_title} (${room.current_position_sec}초)
        </div>
      `;
      div.addEventListener("click", () => {
        currentRoomId = room.room_id;
        loadRooms();
        loadActiveRoom(true);
      });
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = "<div class='room-item-sub'>방 목록을 불러오지 못했습니다.</div>";
  }
}

async function loadActiveRoom(forceSyncAudio = false) {
  const nick = (document.getElementById("commentNick").value || "").trim();
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}?nickname=${encodeURIComponent(nick)}`);
    const data = await res.json();
    if (!res.ok) {
      showResult("createRoomResult", data.error || "방 조회 실패", true);
      return;
    }

    document.getElementById("activeRoomId").textContent = data.room_id;
    document.getElementById("activeRoomTitle").textContent = data.title;
    document.getElementById("activeRoomHost").textContent = data.host;
    document.getElementById("activeRoomCount").textContent = `${data.listener_count} / ${data.max_listeners}명`;
    document.getElementById("nowTrackTitle").textContent = data.track_title;
    document.getElementById("nowTrackArtist").textContent = `- ${data.track_artist}`;
    serverPosText.textContent = `${data.current_position_sec}초 (${formatSec(data.current_position_sec)})`;
    playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";

    // 오디오 주소가 바뀌었거나 강제 동기화 버튼을 누른 경우 <audio> 태그 동기화
    if (lastServerAudioUrl !== data.audio_url) {
      lastServerAudioUrl = data.audio_url;
      audioPlayer.src = data.audio_url;
      forceSyncAudio = true;
    }

    if (forceSyncAudio) {
      audioPlayer.currentTime = Number(data.current_position_sec) || 0;
      if (data.is_playing) {
        audioPlayer.play().catch(() => {});
      } else {
        audioPlayer.pause();
      }
    }

    // 댓글 렌더링
    const commentList = document.getElementById("commentList");
    commentList.innerHTML = "";
    (data.comments || []).forEach((c) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      item.innerHTML = `
        <span class="comment-time">[${formatSec(c.track_timestamp_sec)}]</span>
        <span class="comment-nick">${c.nickname}:</span>
        <span>${c.message}</span>
      `;
      commentList.appendChild(item);
    });
    commentList.scrollTop = commentList.scrollHeight;
  } catch (err) {
    // 네트워크 일시 오류 무시
  }
}

// 기능 1: 새 리스닝 룸 생성
document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const title = document.getElementById("roomTitle").value;
  const host = document.getElementById("roomHost").value;
  const max_listeners = document.getElementById("roomMax").value;

  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, host, max_listeners }),
    });
    const data = await res.json();
    if (!res.ok) {
      showResult("createRoomResult", `[실패/경계 확인] ${data.error}`, true);
      return;
    }
    showResult("createRoomResult", `[정상 동작] '${data.title}' (${data.room_id}) 생성 완료!`);
    document.getElementById("roomTitle").value = "";
    currentRoomId = data.room_id;
    await loadRooms();
    await loadActiveRoom(true);
    await checkHealth();
  } catch (err) {
    showResult("createRoomResult", "서버 요청 중 오류가 발생했습니다.", true);
  }
});

// 프리셋 변경 시 입력칸 자동 채우기
document.getElementById("presetSelect").addEventListener("change", (e) => {
  const sel = e.target;
  const opt = sel.options[sel.selectedIndex];
  if (sel.value !== "custom") {
    document.getElementById("audioUrlInput").value = sel.value;
    document.getElementById("trackTitleInput").value = opt.getAttribute("data-title") || "";
  } else {
    document.getElementById("audioUrlInput").value = "https://my-bucket.s3.ap-northeast-2.amazonaws.com/sample.mp3";
    document.getElementById("trackTitleInput").value = "S3 클라우드 스트리밍 트랙";
  }
});

// 기능 2: DJ 선곡 및 재생 시점 동기화
async function sendPlaybackUpdate(actionType) {
  const track_title = document.getElementById("trackTitleInput").value;
  const audio_url = document.getElementById("audioUrlInput").value;
  const seek_sec = document.getElementById("seekSecInput").value;
  const duration_sec = audioPlayer.duration && isFinite(audioPlayer.duration) ? audioPlayer.duration : 30;

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}/playback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        track_title,
        track_artist: document.getElementById("roomHost").value || "DJ",
        audio_url,
        seek_sec,
        duration_sec,
        action: actionType,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showResult("playbackResult", `[실패/경계 확인] ${data.error}`, true);
      return;
    }
    showResult(
      "playbackResult",
      `[정상 동작] ${data.message} (현재 동기화 시점: ${data.current_position_sec}초)`
    );
    await loadActiveRoom(true);
    await loadRooms();
  } catch (err) {
    showResult("playbackResult", "동기화 요청 중 오류가 발생했습니다.", true);
  }
}

document.getElementById("applyPlaybackBtn").addEventListener("click", () => sendPlaybackUpdate("sync"));
document.getElementById("pausePlaybackBtn").addEventListener("click", () => sendPlaybackUpdate("pause"));
document.getElementById("syncNowBtn").addEventListener("click", () => loadActiveRoom(true));
document.getElementById("refreshRoomsBtn").addEventListener("click", () => loadRooms());

// 기능 3: 실시간 타임스탬프 감상 댓글 전송
document.getElementById("sendCommentBtn").addEventListener("click", async () => {
  const nickname = document.getElementById("commentNick").value;
  const message = document.getElementById("commentMsg").value;

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, message }),
    });
    const data = await res.json();
    if (!res.ok) {
      showResult("commentResult", `[실패/경계 확인] ${data.error}`, true);
      return;
    }
    showResult(
      "commentResult",
      `[정상 동작] [${formatSec(data.comment.track_timestamp_sec)}] 시점에 댓글이 등록되었습니다! (총 ${data.total_comments}개)`
    );
    document.getElementById("commentMsg").value = "";
    await loadActiveRoom(false);
    await loadRooms();
  } catch (err) {
    showResult("commentResult", "댓글 등록 중 오류가 발생했습니다.", true);
  }
});

audioPlayer.addEventListener("timeupdate", () => {
  localPosText.textContent = `${audioPlayer.currentTime.toFixed(1)}초 (${formatSec(audioPlayer.currentTime)})`;
});

// 초기 로드 및 3초 주기 동기화 폴링
checkHealth();
loadRooms();
loadActiveRoom(false);
setInterval(() => {
  loadActiveRoom(false);
}, 3000);
