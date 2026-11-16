function getSessionId() {
  let sid = sessionStorage.getItem("syncbeat_sid");
  if (!sid) {
    sid = "sid-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem("syncbeat_sid", sid);
  }
  return sid;
}

const MY_SESSION_ID = getSessionId();
const ALLOWED_AUDIO_EXTS = [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"];

let selectedRoleMode = "host";
let activeRoomId = null;
let myNickname = "";
let amIHost = false;
let guestAudioUnlocked = false;
let lastServerAudioUrl = "";
let suppressHostEvents = false;
let isSeeking = false;
let availableTracks = [];
let socket = null;

const lobbyView = document.getElementById("lobbyView");
const roomView = document.getElementById("roomView");
const backToLobbyBtn = document.getElementById("backToLobbyBtn");
const audioPlayer = document.getElementById("audioPlayer");
const localPosText = document.getElementById("localPosText");
const durationText = document.getElementById("durationText");
const serverPosText = document.getElementById("serverPosText");
const playStateText = document.getElementById("playStateText");

const seekRange = document.getElementById("seekRange");
const volumeRange = document.getElementById("volumeRange");
const playPauseBtn = document.getElementById("playPauseBtn");
const skipBackBtn = document.getElementById("skipBackBtn");
const skipFwdBtn = document.getElementById("skipFwdBtn");
const muteBtn = document.getElementById("muteBtn");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const volHighIcon = document.getElementById("volHighIcon");
const volMuteIcon = document.getElementById("volMuteIcon");
const discVisual = document.getElementById("discVisual");

audioPlayer.volume = 0.8;

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

function getFileExtension(filename) {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

function updatePlayerVisuals(isPlayingOverride = null) {
  const playing = isPlayingOverride !== null ? isPlayingOverride : !audioPlayer.paused;
  if (playing) {
    playIcon.classList.add("hidden");
    pauseIcon.classList.remove("hidden");
    discVisual.classList.add("playing");
  } else {
    playIcon.classList.remove("hidden");
    pauseIcon.classList.add("hidden");
    discVisual.classList.remove("playing");
  }
}

function updateSeekUI(currentSec, totalSec) {
  const dur = totalSec && isFinite(totalSec) && totalSec > 0 ? totalSec : 16;
  const cur = Math.min(dur, Math.max(0, Number(currentSec) || 0));
  const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
  seekRange.max = String(dur);
  if (!isSeeking) {
    seekRange.value = String(cur);
  }
  seekRange.style.setProperty("--seek-pct", `${pct}%`);
  localPosText.textContent = formatSec(cur);
  durationText.textContent = formatSec(dur);
}

function updateVolumeUI() {
  const muted = audioPlayer.muted || audioPlayer.volume === 0;
  if (muted) {
    volHighIcon.classList.add("hidden");
    volMuteIcon.classList.remove("hidden");
    volumeRange.style.setProperty("--vol-pct", "0%");
  } else {
    volHighIcon.classList.remove("hidden");
    volMuteIcon.classList.add("hidden");
    volumeRange.style.setProperty("--vol-pct", `${Math.round(audioPlayer.volume * 100)}%`);
  }
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

  socket.on("chat_message", (payload) => {
    if (!activeRoomId || payload.room_id !== activeRoomId) return;
    loadActiveRoom(false);
  });

  socket.on("playback_sync", (payload) => {
    if (!activeRoomId || payload.room_id !== activeRoomId) return;
    if (!amIHost) {
      applyServerPlaybackToGuest(payload, true);
    }
  });

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
  updatePlayerVisuals(false);
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
  document.getElementById("nowTrackArtist").textContent = data.track_artist || "";
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

  const totalDur = audioPlayer.duration && isFinite(audioPlayer.duration)
    ? audioPlayer.duration
    : Number(data.duration_sec) || 16;
  updateSeekUI(targetSec, totalDur);
  updatePlayerVisuals(Boolean(data.is_playing));
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
    playPauseBtn.disabled = false;
    skipBackBtn.disabled = false;
    skipFwdBtn.disabled = false;
    seekRange.disabled = false;
  } else {
    badge.textContent = `🙋 게스트 (${myNickname})`;
    badge.className = "my-role-badge guest";
    hostPanel.classList.add("hidden");
    guestNotice.classList.remove("hidden");
    playPauseBtn.disabled = true;
    skipBackBtn.disabled = true;
    skipFwdBtn.disabled = true;
    seekRange.disabled = true;
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
      document.getElementById("nowTrackArtist").textContent = data.track_artist || "";
      serverPosText.textContent = formatSec(data.current_position_sec);
      playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";
      if (lastServerAudioUrl !== data.audio_url) {
        lastServerAudioUrl = data.audio_url;
        suppressHostEvents = true;
        audioPlayer.src = data.audio_url;
        audioPlayer.currentTime = Number(data.current_position_sec) || 0;
        if (data.is_playing) audioPlayer.play().catch(() => {});
        updatePlayerVisuals(Boolean(data.is_playing));
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

// 파일 선택 시 즉시 확장자 검사
document.getElementById("s3FileInput").addEventListener("change", (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const ext = getFileExtension(file.name);
  if (!ALLOWED_AUDIO_EXTS.includes(ext)) {
    showResult(
      "uploadResult",
      `[지원하지 않는 형식] 업로드 가능한 포맷: ${ALLOWED_AUDIO_EXTS.join(", ")}`,
      true
    );
    e.target.value = "";
  } else {
    document.getElementById("uploadResult").style.display = "none";
  }
});

// 기능 2 (호스트): S3 음원 직접 업로드 (선택 곡명 포함)
document.getElementById("uploadS3Btn").addEventListener("click", async () => {
  if (!amIHost || !activeRoomId) return;
  const fileInput = document.getElementById("s3FileInput");
  const titleInput = document.getElementById("uploadTrackTitleInput");
  if (!fileInput.files || !fileInput.files.length) {
    showResult("uploadResult", "[실패/경계 확인] 업로드할 오디오 파일을 선택하세요.", true);
    return;
  }

  const chosenFile = fileInput.files[0];
  const ext = getFileExtension(chosenFile.name);
  if (!ALLOWED_AUDIO_EXTS.includes(ext)) {
    showResult(
      "uploadResult",
      `[지원하지 않는 형식] 업로드 가능한 포맷: ${ALLOWED_AUDIO_EXTS.join(", ")}`,
      true
    );
    return;
  }

  const customTitle = titleInput.value.trim();
  const formData = new FormData();
  formData.append("file", chosenFile);
  formData.append("room_id", activeRoomId);
  formData.append("session_id", MY_SESSION_ID);
  if (customTitle) {
    formData.append("custom_title", customTitle);
  }

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
    titleInput.value = "";
    await loadS3Tracks(data.url);
    document.getElementById("customTrackTitleInput").value = customTitle;
  } catch (err) {
    showResult("uploadResult", "업로드 중 네트워크 오류가 발생했습니다.", true);
  }
});

document.getElementById("trackSelect").addEventListener("change", () => {
  document.getElementById("customTrackTitleInput").value = "";
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

  const customTitle = document.getElementById("customTrackTitleInput").value.trim();
  const finalTitle = customTitle || trackObj.title;
  const seek_sec = customSeek !== null ? customSeek : document.getElementById("seekSecInput").value;
  const duration_sec = audioPlayer.duration && isFinite(audioPlayer.duration)
    ? audioPlayer.duration
    : (trackObj.duration_sec || 30);

  const res = await fetch(`/api/rooms/${encodeURIComponent(activeRoomId)}/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: MY_SESSION_ID,
      track_title: finalTitle,
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

  document.getElementById("nowTrackTitle").textContent = data.track_title;
  document.getElementById("nowTrackArtist").textContent = data.track_artist || "";
  playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";

  suppressHostEvents = true;
  if (audioPlayer.src !== new URL(data.audio_url, window.location.origin).href) {
    audioPlayer.src = data.audio_url;
  }
  audioPlayer.currentTime = Number(data.current_position_sec) || 0;
  if (data.is_playing) audioPlayer.play().catch(() => {});
  else audioPlayer.pause();
  updatePlayerVisuals(Boolean(data.is_playing));
  setTimeout(() => { suppressHostEvents = false; }, 400);
}

// 커스텀 플레이어 버튼 이벤트
playPauseBtn.addEventListener("click", () => {
  if (!amIHost) return;
  if (audioPlayer.paused) {
    broadcastHostPlayback("play", audioPlayer.currentTime || 0);
  } else {
    broadcastHostPlayback("pause", audioPlayer.currentTime || 0);
  }
});

skipBackBtn.addEventListener("click", () => {
  if (!amIHost) return;
  const nextSec = Math.max(0, (audioPlayer.currentTime || 0) - 10);
  broadcastHostPlayback(audioPlayer.paused ? "pause" : "play", nextSec);
});

skipFwdBtn.addEventListener("click", () => {
  if (!amIHost) return;
  const dur = audioPlayer.duration && isFinite(audioPlayer.duration) ? audioPlayer.duration : 16;
  const nextSec = Math.min(dur, (audioPlayer.currentTime || 0) + 10);
  broadcastHostPlayback(audioPlayer.paused ? "pause" : "play", nextSec);
});

seekRange.addEventListener("input", () => {
  isSeeking = true;
  const val = Number(seekRange.value) || 0;
  const max = Number(seekRange.max) || 16;
  const pct = Math.min(100, Math.max(0, (val / max) * 100));
  seekRange.style.setProperty("--seek-pct", `${pct}%`);
  localPosText.textContent = formatSec(val);
});

seekRange.addEventListener("change", () => {
  isSeeking = false;
  if (!amIHost) return;
  const nextSec = Number(seekRange.value) || 0;
  broadcastHostPlayback(audioPlayer.paused ? "pause" : "play", nextSec);
});

volumeRange.addEventListener("input", () => {
  const vol = Number(volumeRange.value);
  audioPlayer.volume = vol;
  audioPlayer.muted = vol === 0;
  updateVolumeUI();
});

muteBtn.addEventListener("click", () => {
  audioPlayer.muted = !audioPlayer.muted;
  if (!audioPlayer.muted && audioPlayer.volume === 0) {
    audioPlayer.volume = 0.5;
    volumeRange.value = "0.5";
  }
  updateVolumeUI();
});

document.getElementById("refreshS3Btn").addEventListener("click", () => loadS3Tracks());
document.getElementById("applyPlaybackBtn").addEventListener("click", () => broadcastHostPlayback("play"));
document.getElementById("pausePlaybackBtn").addEventListener("click", () => broadcastHostPlayback("pause", audioPlayer.currentTime || 0));
document.getElementById("refreshRoomsBtn").addEventListener("click", loadRooms);
document.getElementById("commentSortSelect").addEventListener("change", () => loadActiveRoom(false));

audioPlayer.addEventListener("play", () => {
  updatePlayerVisuals(true);
  if (amIHost && !suppressHostEvents) broadcastHostPlayback("play", audioPlayer.currentTime || 0);
});
audioPlayer.addEventListener("pause", () => {
  updatePlayerVisuals(false);
  if (amIHost && !suppressHostEvents) broadcastHostPlayback("pause", audioPlayer.currentTime || 0);
});
audioPlayer.addEventListener("loadedmetadata", () => {
  updateSeekUI(audioPlayer.currentTime, audioPlayer.duration);
});
audioPlayer.addEventListener("timeupdate", () => {
  updateSeekUI(audioPlayer.currentTime, audioPlayer.duration);
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

window.addEventListener("beforeunload", () => {
  if (activeRoomId) {
    navigator.sendBeacon(
      `/api/rooms/${encodeURIComponent(activeRoomId)}/leave`,
      new Blob([JSON.stringify({ session_id: MY_SESSION_ID })], { type: "application/json" })
    );
  }
});

updateVolumeUI();
initSocket();
checkHealth();
loadRooms();
setInterval(() => {
  if (activeRoomId) loadActiveRoom(false);
  else loadRooms();
}, 3000);
