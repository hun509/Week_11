function getSessionId() {
  let sid = sessionStorage.getItem("syncbeat_sid");
  if (!sid) {
    sid = "sid-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem("syncbeat_sid", sid);
  }
  return sid;
}

const MY_SESSION_ID = getSessionId();
let selectedRoleMode = "host";
let activeRoomId = null;
let myNickname = "";
let amIHost = false;
let guestAudioUnlocked = false;
let lastServerAudioUrl = "";
let suppressHostEvents = false;
let availableTracks = [];
let socket = null;

const lobbyView = document.getElementById("lobbyView");
const roomView = document.getElementById("roomView");
const backToLobbyBtn = document.getElementById("backToLobbyBtn");
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

function initSocket() {
  if (typeof io === "undefined") return;
  socket = io();
  const wsPill = document.getElementById("wsStatusPill");

  socket.on("connect", () => {
    wsPill.textContent = "WebSocket 실시간 연결됨";
    wsPill.classList.add("ok");
    if (activeRoomId) {
      socket.emit("join_ws_room", { room_id: activeRoomId });
    }
  });

  socket.on("disconnect", () => {
    wsPill.textContent = "실시간 연결 재시도 중";
    wsPill.classList.remove("ok");
  });

  // 실시간 채팅 메시지 수신
  socket.on("chat_message", (payload) => {
    if (!activeRoomId || payload.room_id !== activeRoomId) return;
    loadActiveRoom(false);
  });

  // 호스트 재생/정지/선곡 변경 즉시 수신
  socket.on("playback_sync", (payload) => {
    if (!activeRoomId || payload.room_id !== activeRoomId) return;
    if (!amIHost) {
      applyServerPlaybackToGuest(payload, true);
    }
  });

  // 참여 인원 변경 즉시 수신
  socket.on("room_updated", (snapshot) => {
    if (!activeRoomId || snapshot.room_id !== activeRoomId) return;
    renderRoomHeader(snapshot);
  });
}

// 역할 탭 전환
document.getElementById("roleHostBtn").addEventListener("click", () => {
  selectedRoleMode = "host";
  document.getElementById("roleHostBtn").classList.add("active");
  document.getElementById("roleGuestBtn").classList.remove("active");
  document.getElementById("hostSetupBox").classList.remove("hidden");
  document.getElementById("guestSetupBox").classList.add("hidden");
});

document.getElementById("roleGuestBtn").addEventListener("click", () => {
  selectedRoleMode = "guest";
  document.getElementById("roleGuestBtn").classList.add("active");
  document.getElementById("roleHostBtn").classList.remove("active");
  document.getElementById("guestSetupBox").classList.remove("hidden");
  document.getElementById("hostSetupBox").classList.add("hidden");
});

function enterRoomView(roomId, isHost) {
  activeRoomId = roomId;
  amIHost = isHost;
  lobbyView.classList.add("hidden");
  roomView.classList.remove("hidden");
  backToLobbyBtn.classList.remove("hidden");

  document.getElementById("commentAuthorPreview").textContent = myNickname;
  if (socket && socket.connected) {
    socket.emit("join_ws_room", { room_id: roomId });
  }
  loadS3Tracks();
  loadActiveRoom(true);
}

backToLobbyBtn.addEventListener("click", async () => {
  if (activeRoomId) {
    if (socket && socket.connected) {
      socket.emit("leave_ws_room", { room_id: activeRoomId });
    }
    await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}/leave`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: MY_SESSION_ID }),
    });
  }
  activeRoomId = null;
  amIHost = false;
  audioPlayer.pause();
  roomView.classList.add("hidden");
  backToLobbyBtn.classList.add("hidden");
  lobbyView.classList.remove("hidden");
  loadRooms();
});

async function checkHealth() {
  const pill = document.getElementById("healthStatus");
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    if (res.ok && data.status === "ok") {
      pill.textContent = `API 정상 (방 ${data.active_rooms}개)`;
      pill.classList.add("ok");
    } else {
      pill.textContent = "API 오류";
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
      div.className = "room-item";
      div.innerHTML = `
        <div class="room-item-title">${room.title}</div>
        <div class="room-item-sub">
          🎧 DJ: ${room.host} · 👥 ${room.listener_count}/${room.max_listeners}명 · 🎵 ${room.track_title}
        </div>
      `;
      div.addEventListener("click", async () => {
        if (selectedRoleMode !== "guest") {
          document.getElementById("roleGuestBtn").click();
        }
        const guestNick = document.getElementById("guestNickname").value.trim();
        const joinRes = await fetch(`/api/rooms/${encodeURIComponent(room.room_id)}/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nickname: guestNick, session_id: MY_SESSION_ID }),
        });
        const joinData = await joinRes.json();
        if (!joinRes.ok) {
          showResult("lobbyResult", `[실패/경계 확인] ${joinData.error}`, true);
          return;
        }
        myNickname = joinData.nickname;
        enterRoomView(room.room_id, joinData.role === "host");
      });
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = "<div class='room-item-sub'>방 목록을 불러오지 못했습니다.</div>";
  }
}

async function loadS3Tracks(selectUrlAfterLoad = null) {
  const statusEl = document.getElementById("s3StatusText");
  const selectEl = document.getElementById("trackSelect");
  try {
    const res = await fetch("/api/s3/tracks");
    const data = await res.json();
    statusEl.textContent = data.s3_status || "조회 완료";
    availableTracks = data.items || [];

    selectEl.innerHTML = "";
    availableTracks.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = t.url;
      const prefix = t.source === "AWS S3" ? "[S3] " : "[샘플] ";
      opt.textContent = `${prefix}${t.title}${t.size_kb ? ` (${t.size_kb} KB)` : ""}`;
      opt.dataset.idx = String(idx);
      if (selectUrlAfterLoad && t.url === selectUrlAfterLoad) {
        opt.selected = true;
      }
      selectEl.appendChild(opt);
    });
  } catch (e) {
    statusEl.textContent = "트랙 조회 실패";
  }
}

function renderRoomHeader(data) {
  document.getElementById("activeRoomId").textContent = data.room_id;
  document.getElementById("activeRoomTitle").textContent = data.title;
  document.getElementById("activeRoomHost").textContent = data.host;
  document.getElementById("activeRoomCount").textContent = `${data.listener_count} / ${data.max_listeners}명`;

  const chipsEl = document.getElementById("listenerChips");
  chipsEl.innerHTML = "";
  (data.listeners || []).forEach((l) => {
    const chip = document.createElement("span");
    chip.className = "listener-chip";
    chip.textContent = `${l.role === "host" ? "🎧" : "🙋"} ${l.nickname}`;
    chipsEl.appendChild(chip);
  });
}

function applyServerPlaybackToGuest(data, forceSync = false) {
  document.getElementById("nowTrackTitle").textContent = data.track_title;
  document.getElementById("nowTrackArtist").textContent = data.track_artist ? `- ${data.track_artist}` : "";
  serverPosText.textContent = formatSec(data.current_position_sec);
  playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";

  if (lastServerAudioUrl !== data.audio_url) {
    lastServerAudioUrl = data.audio_url;
    audioPlayer.src = data.audio_url;
    forceSync = true;
  }

  const targetSec = Number(data.current_position_sec) || 0;
  const diff = Math.abs((audioPlayer.currentTime || 0) - targetSec);

  if (data.is_playing) {
    if (forceSync || diff > 1.8) {
      audioPlayer.currentTime = targetSec;
    }
    if (audioPlayer.paused && guestAudioUnlocked) {
      audioPlayer.play().catch(() => {});
    }
  } else {
    if (!audioPlayer.paused) audioPlayer.pause();
    if (diff > 1.0) audioPlayer.currentTime = targetSec;
  }
}

function updateRoleUI() {
  const badge = document.getElementById("myRoleBadge");
  const hostPanel = document.getElementById("hostControlPanel");
  const guestNotice = document.getElementById("guestOnlyNotice");
  const guestSyncBar = document.getElementById("guestSyncBar");

  if (amIHost) {
    badge.textContent = `🎧 호스트 (${myNickname})`;
    badge.className = "my-role-badge host";
    hostPanel.classList.remove("hidden");
    guestNotice.classList.add("hidden");
    guestSyncBar.classList.add("hidden");
  } else {
    badge.textContent = `🙋 게스트 (${myNickname})`;
    badge.className = "my-role-badge guest";
    hostPanel.classList.add("hidden");
    guestNotice.classList.remove("hidden");
    if (!guestAudioUnlocked) {
      guestSyncBar.classList.remove("hidden");
    } else {
      guestSyncBar.classList.add("hidden");
    }
  }
}

async function loadActiveRoom(forceSync = false) {
  if (!activeRoomId) return;
  const sortVal = document.getElementById("commentSortSelect").value;
  const params = new URLSearchParams({
    session_id: MY_SESSION_ID,
    nickname: myNickname,
    role: amIHost ? "host" : "guest",
    sort: sortVal,
  });

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) return;

    amIHost = Boolean(data.is_host);
    updateRoleUI();
    renderRoomHeader(data);

    if (!amIHost) {
      applyServerPlaybackToGuest(data, forceSync);
    } else {
      document.getElementById("nowTrackTitle").textContent = data.track_title;
      document.getElementById("nowTrackArtist").textContent = data.track_artist ? `- ${data.track_artist}` : "";
      serverPosText.textContent = formatSec(data.current_position_sec);
      playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";
      if (lastServerAudioUrl !== data.audio_url) {
        lastServerAudioUrl = data.audio_url;
        suppressHostEvents = true;
        audioPlayer.src = data.audio_url;
        audioPlayer.currentTime = Number(data.current_position_sec) || 0;
        if (data.is_playing) audioPlayer.play().catch(() => {});
        setTimeout(() => { suppressHostEvents = false; }, 400);
      }
    }

    const chatEl = document.getElementById("chatMessages");
    const wasAtBottom = chatEl.scrollHeight - chatEl.scrollTop <= chatEl.clientHeight + 40;
    chatEl.innerHTML = "";
    (data.comments || []).forEach((c) => {
      const wrap = document.createElement("div");
      let cls = "other";
      if (c.role === "system") cls = "system";
      else if (c.nickname === myNickname) cls = "mine";
      wrap.className = `chat-bubble-wrap ${cls}`;

      if (c.role === "system") {
        wrap.innerHTML = `<div class="chat-bubble">${c.message}</div>`;
      } else {
        const icon = c.role === "host" ? "🎧" : "🙋";
        wrap.innerHTML = `
          <div class="chat-meta">
            <strong>${icon} ${c.nickname}</strong>
            <span class="chat-track-tag">[곡 ${formatSec(c.track_timestamp_sec)}]</span>
            <span>${c.created_at}</span>
          </div>
          <div class="chat-bubble">${c.message}</div>
        `;
      }
      chatEl.appendChild(wrap);
    });
    if (wasAtBottom || forceSync) {
      chatEl.scrollTop = chatEl.scrollHeight;
    }
  } catch (err) {
    // 일시 오류 무시
  }
}

document.getElementById("enableAutoSyncBtn").addEventListener("click", () => {
  guestAudioUnlocked = true;
  document.getElementById("guestSyncBar").classList.add("hidden");
  audioPlayer.play().catch(() => {});
  loadActiveRoom(true);
});

// 기능 1 (호스트): 방 생성
document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const title = document.getElementById("roomTitle").value;
  const host = document.getElementById("roomHost").value;
  const max_listeners = document.getElementById("roomMax").value;

  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, host, max_listeners, session_id: MY_SESSION_ID }),
  });
  const data = await res.json();
  if (!res.ok) {
    showResult("lobbyResult", `[실패/경계 확인] ${data.error}`, true);
    return;
  }
  myNickname = data.host;
  document.getElementById("roomTitle").value = "";
  enterRoomView(data.room_id, true);
});

// 기능 2 (호스트): S3 음원 직접 업로드
document.getElementById("uploadS3Btn").addEventListener("click", async () => {
  if (!amIHost || !activeRoomId) return;
  const fileInput = document.getElementById("s3FileInput");
  if (!fileInput.files || !fileInput.files.length) {
    showResult("uploadResult", "[실패/경계 확인] 업로드할 오디오 파일을 선택하세요.", true);
    return;
  }

  const formData = new FormData();
  formData.append("file", fileInput.files[0]);
  formData.append("room_id", activeRoomId);
  formData.append("session_id", MY_SESSION_ID);

  showResult("uploadResult", "S3 버킷에 업로드 중...");
  try {
    const res = await fetch("/api/s3/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) {
      showResult("uploadResult", `[실패] ${data.error}`, true);
      return;
    }
    showResult("uploadResult", `[성공] ${data.message}`);
    fileInput.value = "";
    await loadS3Tracks(data.url);
  } catch (err) {
    showResult("uploadResult", "업로드 중 네트워크 오류가 발생했습니다.", true);
  }
});

// 기능 2 (호스트): 선곡 및 재생 동기화 전송
async function broadcastHostPlayback(actionType, customSeek = null) {
  if (!amIHost || !activeRoomId) return;
  const selectEl = document.getElementById("trackSelect");
  const selectedOpt = selectEl.options[selectEl.selectedIndex];
  const idx = selectedOpt ? Number(selectedOpt.dataset.idx) : 0;
  const trackObj = availableTracks[idx] || {
    title: "Sunset Arcade Drive",
    artist: "Cloud DJ",
    url: "/samples/sample_track_1.wav",
    duration_sec: 16,
  };

  const seek_sec = customSeek !== null ? customSeek : document.getElementById("seekSecInput").value;
  const duration_sec = audioPlayer.duration && isFinite(audioPlayer.duration) ? audioPlayer.duration : (trackObj.duration_sec || 30);

  const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: MY_SESSION_ID,
      track_title: trackObj.title,
      track_artist: trackObj.artist,
      audio_url: trackObj.url,
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
  showResult("playbackResult", `[동기화 완료] ${data.track_title} (${formatSec(data.current_position_sec)})`);

  suppressHostEvents = true;
  if (audioPlayer.src !== new URL(data.audio_url, window.location.origin).href) {
    audioPlayer.src = data.audio_url;
  }
  audioPlayer.currentTime = Number(data.current_position_sec) || 0;
  if (data.is_playing) audioPlayer.play().catch(() => {});
  else audioPlayer.pause();
  setTimeout(() => { suppressHostEvents = false; }, 400);
}

document.getElementById("refreshS3Btn").addEventListener("click", () => loadS3Tracks());
document.getElementById("applyPlaybackBtn").addEventListener("click", () => broadcastHostPlayback("play"));
document.getElementById("pausePlaybackBtn").addEventListener("click", () => broadcastHostPlayback("pause", audioPlayer.currentTime || 0));
document.getElementById("refreshRoomsBtn").addEventListener("click", loadRooms);
document.getElementById("commentSortSelect").addEventListener("change", () => loadActiveRoom(false));

audioPlayer.addEventListener("play", () => {
  if (amIHost && !suppressHostEvents) broadcastHostPlayback("play", audioPlayer.currentTime || 0);
});
audioPlayer.addEventListener("pause", () => {
  if (amIHost && !suppressHostEvents) broadcastHostPlayback("pause", audioPlayer.currentTime || 0);
});
audioPlayer.addEventListener("seeked", () => {
  if (amIHost && !suppressHostEvents) broadcastHostPlayback(audioPlayer.paused ? "pause" : "play", audioPlayer.currentTime || 0);
});

// 기능 3: 채팅 전송
async function submitComment() {
  if (!activeRoomId) return;
  const message = document.getElementById("commentMsg").value;
  const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: MY_SESSION_ID, nickname: myNickname, message }),
  });
  const data = await res.json();
  if (!res.ok) {
    showResult("commentResult", `[실패/경계 확인] ${data.error}`, true);
    return;
  }
  document.getElementById("commentResult").style.display = "none";
  document.getElementById("commentMsg").value = "";
  await loadActiveRoom(false);
}

document.getElementById("sendCommentBtn").addEventListener("click", submitComment);
document.getElementById("commentMsg").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    submitComment();
  }
});

audioPlayer.addEventListener("timeupdate", () => {
  localPosText.textContent = formatSec(audioPlayer.currentTime);
});

window.addEventListener("beforeunload", () => {
  if (activeRoomId) {
    navigator.sendBeacon(
      `/api/rooms/${encodeURIComponent(activeRoomId)}/leave`,
      new Blob([JSON.stringify({ session_id: MY_SESSION_ID })], { type: "application/json" })
    );
  }
});

initSocket();
checkHealth();
loadRooms();
setInterval(() => {
  if (activeRoomId) loadActiveRoom(false);
  else loadRooms();
}, 3000);
