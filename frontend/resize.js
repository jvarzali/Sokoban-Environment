// resize.js — drag-to-resize for the bottom pane (vertical) and the 2D|3D split
// (horizontal). Both are clamped so neither side can get too small. Sizes are
// applied via CSS custom properties (--pane-h on body, --col2d on the stage) and
// a synthetic "resize" event is fired so the renderers (app.js) refit.
(function () {
  const body = document.body;
  const stage = document.getElementById("stage");
  const pane = document.getElementById("replayPane");
  const paneResizer = document.getElementById("paneResizer");
  const colResizer = document.getElementById("colResizer");
  if (!stage || !pane || !paneResizer || !colResizer) return;

  const MIN_PANE = 90;     // bottom pane never shorter than this
  const MIN_STAGE = 200;   // board area never shorter than this
  const MIN_PANEL = 220;   // neither split panel narrower than this
  const COL_RESERVED = 34; // 10px handle + 2×12px grid gap

  // Coalesce refits to one per frame so dragging stays smooth.
  let raf = 0;
  const refit = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };

  function bindDrag(handle, onDown) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button) return;                 // left button only
      const ctx = onDown(e);
      if (!ctx) return;
      e.preventDefault();
      handle.classList.add("dragging");
      body.style.userSelect = "none";
      try { handle.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => { ctx(ev); refit(); };
      const up = () => {
        handle.classList.remove("dragging");
        body.style.userSelect = "";
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // Bottom pane: drag up to grow, down to shrink. Cap so the stage keeps MIN_STAGE.
  bindDrag(paneResizer, (e) => {
    const startY = e.clientY;
    const startH = pane.offsetHeight;
    const maxH = Math.max(MIN_PANE, stage.offsetHeight + startH - MIN_STAGE);
    return (ev) => {
      const h = Math.min(maxH, Math.max(MIN_PANE, startH + (startY - ev.clientY)));
      body.style.setProperty("--pane-h", h + "px");
    };
  });

  // Split divider: set the 2D column width; the 3D column takes the rest (1fr).
  bindDrag(colResizer, () => {
    if (!stage.classList.contains("mode-split")) return null;
    const rect = stage.getBoundingClientRect();
    const maxW = rect.width - MIN_PANEL - COL_RESERVED;
    return (ev) => {
      const w = Math.min(maxW, Math.max(MIN_PANEL, ev.clientX - rect.left));
      stage.style.setProperty("--col2d", w + "px");
    };
  });

  // Keep the split ratio valid if the window shrinks (so the 3D panel can't be
  // squeezed below MIN_PANEL). No-op when the split hasn't been resized yet.
  window.addEventListener("resize", () => {
    const cur = stage.style.getPropertyValue("--col2d");
    if (!cur) return;
    const maxW = stage.getBoundingClientRect().width - MIN_PANEL - COL_RESERVED;
    if (parseFloat(cur) > maxW) {
      stage.style.setProperty("--col2d", Math.max(MIN_PANEL, maxW) + "px");
    }
  });
})();
