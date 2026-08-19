(function mountProgramCueWidget() {
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
  var managedEmbed = (script.dataset.programcueEmbed || "").trim();
  if (
    script.hasAttribute("data-programcue-embed") &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(managedEmbed)
  ) {
    throw new Error(
      "Program Cue widget data-programcue-embed must be a valid stable slug.",
    );
  }
  var configurationAttributes = [
    "surface",
    "day",
    "track",
    "format",
    "room",
    "query",
    "accent",
    "controls",
    "density",
    "theme",
    "directory",
    "fields",
  ];
  if (
    managedEmbed &&
    configurationAttributes.some(function hasConfigurationAttribute(name) {
      return script.hasAttribute(`data-${name}`);
    })
  ) {
    throw new Error(
      "Program Cue managed widgets do not accept stateless configuration attributes.",
    );
  }
  var surface = script.hasAttribute("data-surface")
    ? (script.dataset.surface || "").trim()
    : "sessions";
  // Keep already-installed widgets working after Agenda was consolidated into
  // Programme. New snippets never generate this retired surface.
  if (surface === "agenda") surface = "sessions";
  if (!/^(sessions|speakers|schedule|gallery)$/.test(surface)) {
    throw new Error(
      "Program Cue widget data-surface must be sessions, speakers, schedule or gallery.",
    );
  }
  var frameUrl = new URL(
    managedEmbed
      ? "/embed/" +
          encodeURIComponent(slug) +
          "/saved/" +
          encodeURIComponent(managedEmbed)
      : `/embed/${encodeURIComponent(slug)}/${surface}`,
    widgetOrigin,
  );
  configurationAttributes.slice(1).forEach(function copyFilter(name) {
    var value = script.dataset[name];
    if (script.hasAttribute(`data-${name}`)) {
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
  frame.style.height = `${initialHeight}px`;
  frame.style.border = "0";
  frame.style.display = "block";
  target.appendChild(frame);

  window.addEventListener("message", function resizeProgramCueWidget(event) {
    if (event.origin !== widgetOrigin || event.source !== frame.contentWindow)
      return;
    var message = event.data;
    if (
      message?.type !== "programcue:resize" ||
      message.eventSlug !== slug ||
      !Number.isFinite(message.height)
    )
      return;
    var height = Math.ceil(message.height);
    if (height < 160 || height > 20000) return;
    frame.style.height = `${height}px`;
  });
})();
