(function mountProgramCueWidget() {
  "use strict";

  var script = document.currentScript;
  if (!(script instanceof HTMLScriptElement)) {
    throw new Error("Program Cue widget must be loaded from a script element.");
  }
  var slug = (script.dataset.programcueEvent || "").trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(
      "Program Cue widget requires a valid data-programcue-event slug.",
    );
  }
  var target = null;
  if (script.dataset.target) {
    try {
      target = document.querySelector(script.dataset.target);
    } catch {
      throw new Error(
        "Program Cue widget data-target must be a valid selector.",
      );
    }
  }
  if (script.dataset.target && !target) {
    throw new Error("Program Cue widget data-target did not match an element.");
  }
  if (!target) {
    target = document.createElement("div");
    script.parentNode.insertBefore(target, script);
  }

  var widgetOrigin = new URL(script.src, document.baseURI).origin;
  var frameUrl = new URL("/embed/" + encodeURIComponent(slug), widgetOrigin);
  [
    "day",
    "track",
    "format",
    "room",
    "query",
    "accent",
    "controls",
    "density",
    "speakers",
  ].forEach(function copyFilter(name) {
    var value = script.dataset[name];
    if (script.hasAttribute("data-" + name)) {
      frameUrl.searchParams.set(name, value);
    }
  });

  var frame = document.createElement("iframe");
  frame.src = frameUrl.toString();
  frame.title = script.dataset.title || "Event programme";
  frame.loading = "lazy";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.style.width = "100%";
  var initialHeight = 720;
  if (script.hasAttribute("data-height")) {
    initialHeight = Number(script.dataset.height);
    if (
      !/^\d+$/.test(script.dataset.height) ||
      !Number.isSafeInteger(initialHeight) ||
      initialHeight < 160 ||
      initialHeight > 20000
    ) {
      throw new Error(
        "Program Cue widget data-height must be an integer from 160 to 20000.",
      );
    }
  }
  frame.style.height = initialHeight + "px";
  frame.style.border = "0";
  frame.style.display = "block";
  target.appendChild(frame);

  window.addEventListener("message", function resizeProgramCueWidget(event) {
    if (event.origin !== widgetOrigin || event.source !== frame.contentWindow)
      return;
    var message = event.data;
    if (
      !message ||
      message.type !== "programcue:resize" ||
      message.eventSlug !== slug ||
      !Number.isFinite(message.height)
    )
      return;
    var height = Math.ceil(message.height);
    if (height < 160 || height > 20000) return;
    frame.style.height = height + "px";
  });
})();
