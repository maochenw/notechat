(function () {
  // Detect room type from URL
  const isPermanent = window.location.pathname.startsWith("/p/");
  const pathParts = window.location.pathname.split("/");
  const roomId = pathParts[pathParts.length - 1];
  if (!roomId) {
    window.location.href = "/";
    return;
  }

  // Elements
  const passphraseOverlay = document.getElementById("passphrase-overlay");
  const passphraseInput = document.getElementById("passphrase-input");
  const btnPassphrase = document.getElementById("btn-passphrase");
  const btnToggleCodewordRoom = document.getElementById("btn-toggle-codeword-room");
  const passphraseError = document.getElementById("passphrase-error");
  const nameOverlay = document.getElementById("name-overlay");
  const overlayNameInput = document.getElementById("overlay-name-input");
  const overlayNameBtn = document.getElementById("overlay-name-btn");
  const roomUI = document.getElementById("room-ui");
  const shareBanner = document.getElementById("share-banner");
  const roomUrlInput = document.getElementById("room-url");
  const btnCopy = document.getElementById("btn-copy");
  const btnCopyHeader = document.getElementById("btn-copy-header");
  const btnLeave = document.getElementById("btn-leave");
  const messagesEl = document.getElementById("messages");
  const msgInput = document.getElementById("msg-input");
  const btnSend = document.getElementById("btn-send");
  const timerEl = document.getElementById("timer");
  const userCountEl = document.getElementById("user-count");
  const destroyedOverlay = document.getElementById("destroyed-overlay");
  const btnNewRoom = document.getElementById("btn-new-room");
  const fileInput = document.getElementById("file-input");
  const upgradeCta = document.getElementById("upgrade-cta");
  const roomSubtitle = document.querySelector(".room-subtitle");
  const privacyFooter = document.querySelector(".privacy-footer");
  const btnSettings = document.getElementById("btn-settings");
  const userList = document.getElementById("user-list");
  const userListItems = document.getElementById("user-list-items");

  const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB

  let socket = null;
  let mySocketId = null;
  let timerDeadline = 0;
  let timerInterval = null;
  let currentUsers = [];

  // Toggle codeword visibility
  btnToggleCodewordRoom.addEventListener("click", () => {
    const isHidden = passphraseInput.type === "password";
    passphraseInput.type = isHidden ? "text" : "password";
    btnToggleCodewordRoom.querySelector(".eye-open").classList.toggle("hidden");
    btnToggleCodewordRoom.querySelector(".eye-closed").classList.toggle("hidden");
  });

  // Show upgrade CTA on destroyed overlay if permanent rooms are enabled
  fetch("/api/config")
    .then((res) => res.json())
    .then((config) => {
      if (config.permanentRoomsEnabled && upgradeCta) {
        upgradeCta.classList.remove("hidden");
      }
    })
    .catch(() => {});

  // Check if user already has a display name
  let displayName = sessionStorage.getItem("displayName");

  if (isPermanent) {
    // Skip codeword check if user just created this room
    const authenticated = sessionStorage.getItem("codewordAuthenticated");
    if (authenticated === roomId) {
      sessionStorage.removeItem("codewordAuthenticated");
      proceedToName();
    } else {
      checkPassphrase();
    }
  } else if (displayName) {
    sessionStorage.removeItem("displayName");
    connectToRoom(displayName);
  } else {
    nameOverlay.classList.remove("hidden");
    overlayNameInput.focus();

    overlayNameBtn.addEventListener("click", submitName);
    overlayNameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitName();
    });
  }

  async function checkPassphrase() {
    try {
      const res = await fetch("/api/permanent-rooms/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: roomId }),
      });

      const data = await res.json();

      if (data.hasPassphrase && !data.authenticated) {
        // Show passphrase prompt
        passphraseOverlay.classList.remove("hidden");
        passphraseInput.focus();

        btnPassphrase.addEventListener("click", submitPassphrase);
        passphraseInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") submitPassphrase();
        });
      } else {
        // No passphrase needed, proceed to name
        proceedToName();
      }
    } catch {
      // If auth check fails, try to proceed anyway
      proceedToName();
    }
  }

  async function submitPassphrase() {
    const passphrase = passphraseInput.value;
    if (!passphrase) return;

    btnPassphrase.disabled = true;
    passphraseError.classList.add("hidden");

    try {
      const res = await fetch("/api/permanent-rooms/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: roomId, passphrase }),
      });

      if (!res.ok) {
        passphraseError.classList.remove("hidden");
        btnPassphrase.disabled = false;
        return;
      }

      passphraseOverlay.classList.add("hidden");
      proceedToName();
    } catch {
      passphraseError.textContent = "Network error. Try again.";
      passphraseError.classList.remove("hidden");
      btnPassphrase.disabled = false;
    }
  }

  function proceedToName() {
    if (displayName) {
      sessionStorage.removeItem("displayName");
      connectToRoom(displayName);
    } else {
      nameOverlay.classList.remove("hidden");
      overlayNameInput.focus();

      overlayNameBtn.addEventListener("click", submitName);
      overlayNameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitName();
      });
    }
  }

  function submitName() {
    const name = overlayNameInput.value.trim();
    if (!name) {
      overlayNameInput.focus();
      return;
    }
    nameOverlay.classList.add("hidden");
    connectToRoom(name);
  }

  function connectToRoom(name) {
    displayName = name;
    roomUI.classList.remove("hidden");

    // Set room URL
    roomUrlInput.value = window.location.href;

    // Update subtitle for permanent rooms
    if (isPermanent) {
      roomSubtitle.textContent = "Permanent private room";
      privacyFooter.textContent = "Messages are never stored. They disappear when everyone leaves.";
      btnSettings.classList.remove("hidden");
      timerEl.style.display = "none";
    }

    socket = io();

    socket.on("connect", () => {
      mySocketId = socket.id;
      socket.emit("join-room", {
        roomId,
        displayName: name,
        roomType: isPermanent ? "permanent" : "ephemeral",
      });
    });

    socket.on("room-joined", (data) => {
      timerDeadline = Date.now() + data.remainingMs;
      updateUserCount(data.userCount, data.users);

      if (data.roomType !== "permanent") {
        startTimer();
      }

      // Show share banner: always for ephemeral rooms when alone,
      // only on first creation for permanent rooms
      if (isPermanent) {
        const justCreated = sessionStorage.getItem("roomJustCreated");
        if (justCreated === roomId && data.userCount <= 1) {
          shareBanner.classList.remove("hidden");
        } else {
          shareBanner.classList.add("hidden");
        }
        sessionStorage.removeItem("roomJustCreated");
      } else if (data.userCount <= 1) {
        shareBanner.classList.remove("hidden");
      } else {
        shareBanner.classList.add("hidden");
      }

      addSystemMessage(`You joined as ${data.displayName}`);
    });

    socket.on("user-joined", (data) => {
      updateUserCount(data.userCount, data.users);
      shareBanner.classList.add("hidden");
      addSystemMessage(`${data.displayName} joined the room`);
    });

    socket.on("user-left", (data) => {
      updateUserCount(data.userCount, data.users);
      addSystemMessage(`${data.displayName} left the room`);
    });

    socket.on("chat-message", (data) => {
      addChatMessage(data);
    });

    socket.on("chat-media", (data) => {
      addMediaMessage(data);
    });

    socket.on("error-msg", (msg) => {
      addSystemMessage(msg);
    });

    socket.on("room-destroyed", () => {
      clearInterval(timerInterval);
      roomUI.classList.add("hidden");
      destroyedOverlay.classList.remove("hidden");
    });

    socket.on("disconnect", () => {
      addSystemMessage("Disconnected from server. Reconnecting\u2026");
    });

    socket.on("reconnect", () => {
      socket.emit("join-room", {
        roomId,
        displayName: name,
        roomType: isPermanent ? "permanent" : "ephemeral",
      });
    });

    // Send message handlers
    btnSend.addEventListener("click", sendMessage);
    msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Copy link (share banner)
    btnCopy.addEventListener("click", () => {
      copyRoomLink(btnCopy);
    });

    // Copy link (header)
    btnCopyHeader.addEventListener("click", () => {
      copyRoomLink(btnCopyHeader);
    });

    // Settings button (permanent rooms only)
    btnSettings.addEventListener("click", () => {
      window.location.href = `/p/${roomId}/settings`;
    });

    // Toggle user list
    userCountEl.addEventListener("click", () => {
      userList.classList.toggle("hidden");
    });

    // Close user list when clicking outside
    document.addEventListener("click", (e) => {
      if (!userCountEl.contains(e.target) && !userList.contains(e.target)) {
        userList.classList.add("hidden");
      }
    });

    // Leave room
    btnLeave.addEventListener("click", () => {
      socket.disconnect();
      clearInterval(timerInterval);
      window.location.href = "/";
    });

    // File upload
    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = "";

      if (file.size > MAX_FILE_SIZE) {
        addSystemMessage("File is too large. Maximum size is 200 MB.");
        return;
      }

      const mediaType = file.type.startsWith("video") ? "video" : "image";

      const reader = new FileReader();
      reader.onload = () => {
        socket.emit("chat-media", { dataUrl: reader.result, mediaType });
      };
      reader.readAsDataURL(file);
    });

    // New room button
    btnNewRoom.addEventListener("click", () => {
      window.location.href = "/";
    });

  }

  function copyRoomLink(btn) {
    const originalText = btn.textContent;
    navigator.clipboard.writeText(window.location.href).then(() => {
      btn.textContent = "Copied!";
      socket.emit("link-share");
      setTimeout(() => {
        btn.textContent = originalText;
      }, 2000);
    });
  }

  function sendMessage() {
    const msg = msgInput.value.trim();
    if (!msg) return;
    socket.emit("chat-message", { message: msg });
    msgInput.value = "";
    msgInput.blur();
  }

  function addChatMessage(data) {
    const div = document.createElement("div");
    const isMe = data.senderId === mySocketId;
    div.className = `msg ${isMe ? "msg-me" : "msg-other"}`;

    const header = document.createElement("div");
    header.className = "msg-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "msg-name";
    nameSpan.textContent = isMe ? "You" : data.displayName;

    header.appendChild(nameSpan);

    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = data.message;

    div.appendChild(header);
    div.appendChild(body);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addMediaMessage(data) {
    const div = document.createElement("div");
    const isMe = data.senderId === mySocketId;
    div.className = `msg ${isMe ? "msg-me" : "msg-other"}`;

    const header = document.createElement("div");
    header.className = "msg-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "msg-name";
    nameSpan.textContent = isMe ? "You" : data.displayName;

    header.appendChild(nameSpan);

    const media = document.createElement("div");
    media.className = "msg-media";

    if (data.mediaType === "video") {
      const video = document.createElement("video");
      video.src = data.dataUrl;
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      media.appendChild(video);
    } else {
      const img = document.createElement("img");
      img.src = data.dataUrl;
      img.alt = "Shared image";
      img.loading = "lazy";
      media.appendChild(img);
    }

    div.appendChild(header);
    div.appendChild(media);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg-system";
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function updateUserCount(count, users) {
    userCountEl.textContent = `${count} online`;
    if (users) {
      currentUsers = users;
      renderUserList();
    }
  }

  function renderUserList() {
    userListItems.innerHTML = "";
    currentUsers.forEach((name) => {
      const li = document.createElement("li");
      li.textContent = name;
      userListItems.appendChild(li);
    });
  }

  function startTimer() {
    clearInterval(timerInterval);
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      const remaining = timerDeadline - Date.now();
      if (remaining <= 0) {
        clearInterval(timerInterval);
      }
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay() {
    const remaining = Math.max(0, timerDeadline - Date.now());
    const totalSeconds = Math.floor(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    timerEl.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    // Visual warning when < 5 minutes
    if (totalSeconds < 300) {
      timerEl.classList.add("timer-warning");
    }
    if (totalSeconds < 60) {
      timerEl.classList.add("timer-critical");
    }
  }
})();
