(function () {
  const btnCreate = document.getElementById("btn-create");
  const stepCreate = document.getElementById("step-create");
  const stepName = document.getElementById("step-name");
  const inputName = document.getElementById("input-name");
  const btnEnter = document.getElementById("btn-enter");
  const tagline = document.getElementById("tagline");

  // Permanent room elements
  const permanentCta = document.getElementById("permanent-cta");
  const btnPermanent = document.getElementById("btn-permanent");

  let pendingRoomId = null;
  let checkoutUrl = null;

  // Check for URL params
  const params = new URLSearchParams(window.location.search);
  if (params.get("cancelled")) {
    window.history.replaceState({}, "", "/");
  }
  if (params.get("upgrade")) {
    window.history.replaceState({}, "", "/");
  }

  // Fetch config and update tagline + permanent room visibility
  fetch("/api/config")
    .then((res) => res.json())
    .then((config) => {
      const totalSeconds = Math.floor(config.roomLifetimeMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const hours = Math.floor(minutes / 60);
      const remainMinutes = minutes % 60;

      let timeStr;
      if (hours > 0 && remainMinutes > 0) {
        timeStr = `${hours}h ${remainMinutes}m`;
      } else if (hours > 0) {
        timeStr = `${hours} hour${hours > 1 ? "s" : ""}`;
      } else if (minutes > 0) {
        timeStr = `${minutes} minute${minutes > 1 ? "s" : ""}`;
      } else {
        timeStr = `${totalSeconds} second${totalSeconds > 1 ? "s" : ""}`;
      }

      tagline.textContent = `Anonymous rooms that self-destruct after ${timeStr}.`;

      // Show permanent room CTA if enabled
      if (config.permanentRoomsEnabled && config.permanentRoomCheckoutUrl) {
        permanentCta.classList.remove("hidden");
        checkoutUrl = config.permanentRoomCheckoutUrl;
      }
    })
    .catch(() => {});

  // --- Ephemeral room flow ---
  btnCreate.addEventListener("click", async () => {
    btnCreate.disabled = true;
    btnCreate.textContent = "Creating…";

    try {
      const res = await fetch("/api/rooms", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Could not create room. Please try again.");
        btnCreate.disabled = false;
        btnCreate.textContent = "Create Anonymous Room";
        return;
      }

      const { roomId } = await res.json();
      pendingRoomId = roomId;

      // Show name prompt
      stepCreate.classList.add("hidden");
      stepName.classList.remove("hidden");
      inputName.focus();
    } catch {
      alert("Network error. Please try again.");
      btnCreate.disabled = false;
      btnCreate.textContent = "Create Anonymous Room";
    }
  });

  btnEnter.addEventListener("click", goToRoom);
  inputName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") goToRoom();
  });

  function goToRoom() {
    const name = inputName.value.trim();
    if (!name) {
      inputName.focus();
      return;
    }
    if (!pendingRoomId) return;

    sessionStorage.setItem("displayName", name);
    window.location.href = `/room/${pendingRoomId}`;
  }

  // --- Permanent room flow ---
  btnPermanent.addEventListener("click", () => {
    if (checkoutUrl) {
      window.location.href = checkoutUrl;
    }
  });
})();
