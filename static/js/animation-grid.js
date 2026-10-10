(function renderAnimationGridImmediately() {
  "use strict";

  const animationRoot = "./source/anim/run_anim_texture_glb_gp";
  const methods = [
    { directory: "gt", label: "Ground Truth" },
    { directory: "ours", label: "Ours" },
    { directory: "mia", label: "MIA" },
    { directory: "unirig", label: "UniRig" },
    { directory: "pinocchio", label: "Pinocchio" },
  ];
  const samples = [
    { file: "514_WD.glb", label: "Model" },
    { file: "Arissa_TG_update.glb", label: "Arissa" },
    { file: "fox_TG.glb", label: "Fox", missing: ["mia"] },
    { file: "peasant_run.glb", label: "Peasant" },
  ];

  function hasResult(sample, methodDirectory) {
    return !sample.missing?.includes(methodDirectory);
  }

  function createCard(sample, method) {
    const card = document.createElement("article");
    const resultExists = hasResult(sample, method.directory);
    card.className = resultExists
      ? "model-card rig-viewer animation-card is-loading"
      : "model-card animation-card animation-card--empty";

    if (resultExists) {
      card.dataset.model = `${animationRoot}/${method.directory}/${sample.file}`;
      card.dataset.animation = "true";
      card.dataset.viewerEnabled = "false";
      card.setAttribute("aria-busy", "true");
    }

    const header = document.createElement("header");
    header.className = "model-card-header";
    const heading = document.createElement("h3");
    heading.textContent = method.label;
    header.append(heading);
    card.append(header);

    const stage = document.createElement("div");
    stage.className = "viewer-stage animation-stage";

    if (resultExists) {
      const canvas = document.createElement("canvas");
      canvas.className = "rig-canvas";
      canvas.setAttribute("aria-label", `Interactive ${sample.label}, ${method.label} animation`);
      const status = document.createElement("div");
      status.className = "viewer-status";
      status.setAttribute("role", "status");
      status.textContent = "Loading animation…";
      stage.append(canvas, status);
    } else {
      const unavailable = document.createElement("p");
      unavailable.className = "animation-unavailable";
      unavailable.textContent = "No result available";
      stage.append(unavailable);
    }
    card.append(stage);

    const controls = document.createElement("div");
    controls.className = "viewer-controls";
    if (resultExists) {
      controls.setAttribute("aria-label", `${method.label} animation display modes`);
      controls.innerHTML = `
        <button class="viewer-mode is-active" type="button" data-mode="mesh" aria-pressed="true" disabled>Mesh</button>
        <span class="bone-mode-buttons"></span>
        <button class="viewer-mode" type="button" data-mode="weights" aria-pressed="false" disabled>Weights</button>
      `;
    } else {
      controls.setAttribute("aria-hidden", "true");
    }
    card.append(controls);

    const instructions = document.createElement("p");
    instructions.className = "model-instructions";
    if (resultExists) {
      instructions.innerHTML = `
        <span aria-hidden="true"><i class="fa-solid fa-arrows-rotate"></i></span>
        Drag · Scroll to zoom
      `;
    } else {
      instructions.setAttribute("aria-hidden", "true");
      instructions.innerHTML = "&nbsp;";
    }
    card.append(instructions);

    return card;
  }

  const grid = document.querySelector("#animation-grid");
  const tabs = document.querySelector("#animation-tabs");
  if (!grid || !tabs) {
    return;
  }

  let selectedIndex = -1;
  const panels = [];
  const buttons = [];

  function selectSample(index, focus = false) {
    if (index === selectedIndex) return;
    selectedIndex = index;
    panels.forEach((panel, panelIndex) => {
      const active = panelIndex === index;
      panel.hidden = !active;
      panel.querySelectorAll(".rig-viewer").forEach((card) => {
        card.dataset.viewerEnabled = String(active);
      });
      buttons[panelIndex].setAttribute("aria-selected", String(active));
      buttons[panelIndex].tabIndex = active ? 0 : -1;
    });
    document.dispatchEvent(new CustomEvent("animation-sample-change"));
    if (focus) buttons[index].focus();
  }

  samples.forEach((sample, index) => {
    const button = document.createElement("button");
    button.className = "animation-tab";
    button.type = "button";
    button.id = `animation-tab-${index}`;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", `animation-panel-${index}`);
    button.textContent = sample.label;
    button.addEventListener("click", () => selectSample(index));
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % samples.length;
      if (event.key === "ArrowLeft") next = (index + samples.length - 1) % samples.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = samples.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        selectSample(next, true);
      }
    });
    buttons.push(button);
    tabs.append(button);

    const panel = document.createElement("div");
    panel.className = "model-grid animation-grid animation-panel";
    panel.id = `animation-panel-${index}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", button.id);
    panel.hidden = true;
    methods.forEach((method) => panel.append(createCard(sample, method)));
    panels.push(panel);
    grid.append(panel);
  });
  selectSample(0);
})();
