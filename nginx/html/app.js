function getSessionId() {
  let sid = sessionStorage.getItem("syncbeat_sid");
  if (!sid) {
    sid = "sid-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    sessionStorage.setItem("syncbeat_sid", sid);
  }
  return sid;
}

const MY_SESSION_ID = getSessionId();
let selectedRoleMode = "host"; // "host" | "guest"
let currentRoomId = "room-kdu-01";
let myJoinedRoomId = null;
let myNickname = "";
let amIHostOfActiveRoom = false;
let guestAudioUnlocked = false;
let lastServerAudioUrl = "/samples/sample_track_1.wav";
let suppressHostEvents = false;
let availableTracks = [];

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

function updateNicknameLabels() {
  const label = myNickname || "미입장 (기능 1에서 입장)";
  document.getElementById("currentNickLabel").textContent = label;
  document.getElementById("commentAuthorPreview").textContent = label;
}

// 역할 탭 전환 (호스트 vs 게스트)
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

async function loadS3Tracks() {
  const bucket = document.getElementById("s3BucketInput").value.trim();
  const region = document.getElementById("s3RegionInput").value;
  const statusEl = document.getElementById("s3StatusText");
  const selectEl = document.getElementById("trackSelect");

  try {
    const params = new URLSearchParams();
    if (bucket) params.set("bucket", bucket);
    if (region) params.set("region", region);

    const res = await fetch(`/api/s3/tracks?${params.toString()}`);
    const data = await res.json();
    statusEl.textContent = data.s3_status || "조회 완료";
    availableTracks = data.items || [];

    selectEl.innerHTML = "";
    availableTracks.forEach((t, idx) => {
      const opt = document.createElement("option");
      opt.value = t.url;
      opt.textContent = `${t.title}${t.size_kb ? ` (${t.size_kb} KB)` : ""}`;
      opt.dataset.idx = String(idx);
      selectEl.appendChild(opt);
    });
  } catch (e) {
    statusEl.textContent = "트랙 목록 조회 실패";
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
          DJ: ${room.host} · 접속 ${room.listener_count}/${room.max_listeners}명 · 🎵 ${room.track_title}
        </div>
      `;
      div.addEventListener("click", async () => {
        if (selectedRoleMode === "guest") {
          const guestNick = document.getElementById("guestNickname").value.trim();
          const joinRes = await fetch(`/api/rooms/${encodeURIComponent(room.room_id)}/join`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nickname: guestNick, session_id: MY_SESSION_ID }),
          });
          const joinData = await joinRes.json();
          if (!joinRes.ok) {
            showResult("createRoomResult", `[실패/경계 확인] ${joinData.error}`, true);
            return;
          }
          myNickname = joinData.nickname;
          myJoinedRoomId = room.room_id;
          updateNicknameLabels();
          showResult("createRoomResult", `[정상 동작] ${joinData.message} (닉네임: ${myNickname})`);
        }
        currentRoomId = room.room_id;
        await loadRooms();
        await loadActiveRoom(true);
      });
      listEl.appendChild(div);
    });
  } catch (e) {
    listEl.innerHTML = "<div class='room-item-sub'>방 목록을 불러오지 못했습니다.</div>";
  }
}

function updateRoleUI() {
  const badge = document.getElementById("myRoleBadge");
  const hostPanel = document.getElementById("hostControlPanel");
  const guestNotice = document.getElementById("guestOnlyNotice");
  const guestSyncBar = document.getElementById("guestSyncBar");

  if (amIHostOfActiveRoom) {
    badge.textContent = `🎧 호스트 (${myNickname})`;
    badge.className = "my-role-badge host";
    hostPanel.classList.remove("hidden");
    guestNotice.classList.add("hidden");
    guestSyncBar.classList.add("hidden");
    audioPlayer.controls = true;
  } else {
    badge.textContent = myJoinedRoomId === currentRoomId ? `🙋 게스트 (${myNickname})` : "미입장 (게스트 대기)";
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
  const sortVal = document.getElementById("commentSortSelect").value;
  const params = new URLSearchParams({
    session_id: MY_SESSION_ID,
    sort: sortVal,
  });
  if (myJoinedRoomId === currentRoomId && myNickname) {
    params.set("nickname", myNickname);
    params.set("role", amIHostOfActiveRoom ? "host" : "guest");
  }

  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}?${params.toString()}`);
    const data = await res.json();
    if (!res.ok) return;

    amIHostOfActiveRoom = Boolean(data.is_host);
    updateRoleUI();

    document.getElementById("activeRoomId").textContent = data.room_id;
    document.getElementById("activeRoomTitle").textContent = data.title;
    document.getElementById("activeRoomHost").textContent = data.host;
    document.getElementById("activeRoomCount").textContent = `${data.listener_count} / ${data.max_listeners}명`;
    document.getElementById("nowTrackTitle").textContent = data.track_title;
    document.getElementById("nowTrackArtist").textContent = `- ${data.track_artist}`;
    serverPosText.textContent = `${data.current_position_sec}초 (${formatSec(data.current_position_sec)})`;
    playStateText.textContent = data.is_playing ? "재생 중" : "일시정지";

    // 참여자 칩 렌더링
    const chipsEl = document.getElementById("listenerChips");
    chipsEl.innerHTML = "";
    (data.listeners || []).forEach((l) => {
      const chip = document.createElement("span");
      chip.className = "listener-chip";
      chip.textContent = `${l.role === "host" ? "🎧" : "🙋"} ${l.nickname}`;
      chipsEl.appendChild(chip);
    });

    // 게스트는 호스트 상태에 맞춰 자동 동기화
    if (!amIHostOfActiveRoom) {
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
        if (!audioPlayer.paused) {
          audioPlayer.pause();
        }
        if (diff > 1.0) {
          audioPlayer.currentTime = targetSec;
        }
      }
    } else if (lastServerAudioUrl !== data.audio_url) {
      lastServerAudioUrl = data.audio_url;
      suppressHostEvents = true;
      audioPlayer.src = data.audio_url;
      audioPlayer.currentTime = Number(data.current_position_sec) || 0;
      if (data.is_playing) audioPlayer.play().catch(() => {});
      setTimeout(() => { suppressHostEvents = false; }, 400);
    }

    // 댓글 렌더링 (실제 시간 + 곡 시간 동시 표시)
    const commentList = document.getElementById("commentList");
    commentList.innerHTML = "";
    (data.comments || []).forEach((c) => {
      const item = document.createElement("div");
      item.className = "comment-item";
      const roleIcon = c.role === "host" ? "🎧" : "🙋";
      item.innerHTML = `
        <div class="comment-meta">
          <span class="comment-nick">${roleIcon} ${c.nickname}</span>
          <span class="comment-track-time">[곡 ${formatSec(c.track_timestamp_sec)}]</span>
          <span class="comment-real-time">실제시각 ${c.created_at} (KST)</span>
        </div>
        <div>${c.message}</div>
      `;
      commentList.appendChild(item);
    });
  } catch (err) {
    // 네트워크 일시 오류 무시
  }
}

// 게스트: 자동 동기화 허용 버튼
document.getElementById("enableAutoSyncBtn").addEventListener("click", () => {
  guestAudioUnlocked = true;
  document.getElementById("guestSyncBar").classList.add("hidden");
  audioPlayer.play().catch(() => {});
  loadActiveRoom(true);
});

// 기능 1 (호스트): 새 리스닝 룸 생성
document.getElementById("createRoomBtn").addEventListener("click", async () => {
  const title = document.getElementById("roomTitle").value;
  const host = document.getElementById("roomHost").value;
  const max_listeners = document.getElementById("roomMax").value;

  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, host, max_listeners, session_id: MY_SESSION_ID }),
    });
    const data = await res.json();
    if (!res.ok) {
      showResult("createRoomResult", `[실패/경계 확인] ${data.error}`, true);
      return;
    }
    myNickname = data.host;
    myJoinedRoomId = data.room_id;
    currentRoomId = data.room_id;
    amIHostOfActiveRoom = true;
    updateNicknameLabels();
    showResult("createRoomResult", `[정상 동작] 호스트 방 '${data.title}' 생성 완료!`);
    document.getElementById("roomTitle").value = "";
    await loadRooms();
    await loadActiveRoom(true);
    await checkHealth();
  } catch (err) {
    showResult("createRoomResult", "서버 요청 중 오류가 발생했습니다.", true);
  }
});

// 기능 2 (호스트 전용): 선곡 및 상태 전송
async function broadcastHostPlayback(actionType, customSeek = null) {
  if (!amIHostOfActiveRoom) return;
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

  const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}/playback`, {
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
  showResult("playbackResult", `[정상 동작] ${data.message} (${data.current_position_sec}초)`);

  suppressHostEvents = true;
  if (audioPlayer.src !== new URL(data.audio_url, window.location.origin).href) {
    audioPlayer.src = data.audio_url;
  }
  audioPlayer.currentTime = Number(data.current_position_sec) || 0;
  if (data.is_playing) {
    audioPlayer.play().catch(() => {});
  } else {
    audioPlayer.pause();
  }
  setTimeout(() => { suppressHostEvents = false; }, 400);
  await loadActiveRoom(false);
}

document.getElementById("loadS3Btn").addEventListener("click", loadS3Tracks);
document.getElementById("applyPlaybackBtn").addEventListener("click", () => broadcastHostPlayback("play"));
document.getElementById("pausePlaybackBtn").addEventListener("click", () => broadcastHostPlayback("pause", audioPlayer.currentTime || 0));
document.getElementById("refreshRoomsBtn").addEventListener("click", loadRooms);
document.getElementById("commentSortSelect").addEventListener("change", () => loadActiveRoom(false));

// 호스트가 <audio> 컨트롤을 직접 조작할 때도 게스트에게 자동 전파
audioPlayer.addEventListener("play", () => {
  if (amIHostOfActiveRoom && !suppressHostEvents) {
    broadcastHostPlayback("play", audioPlayer.currentTime || 0);
  }
});
audioPlayer.addEventListener("pause", () => {
  if (amIHostOfActiveRoom && !suppressHostEvents) {
    broadcastHostPlayback("pause", audioPlayer.currentTime || 0);
  }
});
audioPlayer.addEventListener("seeked", () => {
  if (amIHostOfActiveRoom && !suppressHostEvents) {
    broadcastHostPlayback(audioPlayer.paused ? "pause" : "play", audioPlayer.currentTime || 0);
  }
});

// 기능 3: 댓글 전송
async function submitComment() {
  const message = document.getElementById("commentMsg").value;
  const res = await fetch(`/api/rooms/${encodeURIComponent(currentRoomId)}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: MY_SESSION_ID, nickname: myNickname, message }),
  });
  const data = await res.json();
  if (!res.ok) {
    showResult("commentResult", `[실패/경계 확인] ${data.error}`, true);
    return;
  }
  showResult(
    "commentResult",
    `[정상 동작] [곡 ${formatSec(data.comment.track_timestamp_sec)} / 실제 ${data.comment.created_at}] 등록 완료!`
  );
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
  localPosText.textContent = `${audioPlayer.currentTime.toFixed(1)}초 (${formatSec(audioPlayer.currentTime)})`;
});

window.addEventListener("beforeunload", () => {
  if (myJoinedRoomId) {
    navigator.sendBeacon(
      `/api/rooms/${encodeURIComponent(myJoinedRoomId)}/leave`,
      new Blob([JSON.stringify({ session_id: MY_SESSION_ID })], { type: "application/json" })
    );
  }
});

// 초기화
updateNicknameLabels();
checkHealth();
loadS3Tracks();
loadRooms();
loadActiveRoom(false);
setInterval(() => {
  loadActiveRoom(false);
  loadRooms();
}, 2000);
