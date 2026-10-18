import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import vm from "node:vm";

const cacheSource = readFileSync(new URL("../static/js/viewer-cache.js", import.meta.url), "utf8").replace(/^export /gm, "");
const viewerSource = readFileSync(new URL("../static/js/viewer.js", import.meta.url), "utf8").replace(/^import[\s\S]*?;\n/gm, "");

function harness(saved = new Map(), blockedStorage = false) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.values = [x, y, z]; }
    normalize() { return this; }
    fromArray(values) { this.values = [...values]; return this; }
    toArray() { return [...this.values]; }
  }
  class Box3 {
    constructor(min, max) { this.min = min; this.max = max; }
  }
  class BufferAttribute {
    constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
  }
  const document = { hidden: false, querySelectorAll: () => [], addEventListener() {} };
  const window = {
    location: { href: "http://localhost:8000/" },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    console, URL, crypto: webcrypto, Uint8Array, Float32Array, document, window,
    performance: { now: () => now },
    THREE: {
      Vector3, Box3, BufferAttribute,
      MathUtils: { degToRad: (value) => value * Math.PI / 180 },
      MeshStandardMaterial: class { constructor(options) { Object.assign(this, options); } },
      Color: class { setHSL(h, s, l) { Object.assign(this, { r: h, g: s, b: l }); return this; } },
    },
    GLTFLoader: class {},
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error("storage disabled"); return saved.get(key); },
      setItem(key, value) { if (blockedStorage) throw new Error("quota"); saved.set(key, value); },
    },
  });
  vm.runInContext(`${cacheSource}\n${viewerSource}\nglobalThis.testAPI = { RigViewer, AnimationPlaybackGroup, fingerprintModel, readModelBounds, saveModelBounds, idleViewers, retainIdleViewer, viewerLoadQueue, processViewerLoadQueue };`, context);
  return { ...context.testAPI, context, timers, document, saved, setNow: (value) => { now = value; } };
}

const h = harness();
const url = "http://localhost:8000/source/model1.glb";
const bytes = new Uint8Array([1, 2, 3]).buffer;
const fingerprint = await h.fingerprintModel(bytes);
assert.equal(fingerprint.length, 64);
const bounds = { min: [-1, 0, -2], max: [1, 4, 2] };
assert.equal(h.readModelBounds(url, fingerprint), null);
h.saveModelBounds(url, fingerprint, bounds);
const reloaded = harness(h.saved);
assert.deepEqual(JSON.parse(JSON.stringify(reloaded.readModelBounds(url, fingerprint))), bounds);
assert.equal(reloaded.readModelBounds(url, await h.fingerprintModel(new Uint8Array([1, 2, 4]).buffer)), null);
assert.equal(h.readModelBounds(url, null), null);
h.saveModelBounds("invalid", fingerprint, { min: [2, 0, 0], max: [1, 1, 1] });
assert.equal(h.readModelBounds("invalid", fingerprint), null);
for (let i = 0; i < 70; i++) h.saveModelBounds(`model-${i}`, fingerprint, bounds);
assert.equal(JSON.parse([...h.saved.values()][0]).length, 64);
assert.equal(h.readModelBounds("model-0", fingerprint), null);
const blocked = harness(new Map(), true);
blocked.saveModelBounds(url, fingerprint, bounds);
assert.ok(blocked.readModelBounds(url, fingerprint));
assert.equal(harness(new Map([["tailorrig:model-bounds:v1", "broken JSON"]])).readModelBounds(url, fingerprint), null);
console.log("PASS: persisted bounds survive reloads; changed models and invalid records miss; storage failures degrade safely; record count is bounded.");

const viewer = Object.create(reloaded.RigViewer.prototype);
Object.assign(viewer, { boundsCacheUrl: url, modelFingerprint: fingerprint });
viewer.calculateContentBounds = () => { throw new Error("cache hit must not sample animation"); };
assert.deepEqual(viewer.computeContentBounds().min.toArray(), bounds.min);
viewer.modelFingerprint = "updated";
let boundCalculations = 0;
viewer.calculateContentBounds = () => {
  boundCalculations++;
  return { min: { toArray: () => bounds.min }, max: { toArray: () => bounds.max } };
};
viewer.computeContentBounds();
viewer.computeContentBounds();
assert.equal(boundCalculations, 1);
console.log("PASS: cached models skip animation sampling; changed models calculate once and cache the new result.");

function geometry(attributes) {
  return {
    getAttribute: (name) => attributes[name],
    setAttribute(name, value) { attributes[name] = value; },
    clone: () => geometry({ ...attributes }),
  };
}
const channels = (values) => Object.fromEntries(["getX", "getY", "getZ", "getW"].map((name, channel) => [name, (index) => values[index][channel]]));
const displayGeometry = geometry({
  position: { count: 2 },
  skinIndex: channels([[0, 1, 0, 0], [1, 0, 0, 0]]),
  skinWeight: channels([[0.25, 0.75, 0, 0], [0.5, 0, 0, 0]]),
});
const weightsViewer = Object.create(h.RigViewer.prototype);
const record = {
  mesh: { isSkinnedMesh: true }, displayGeometry, weightGeometry: null, weightMaterial: null,
  boneColors: [{ r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }],
};
weightsViewer.meshRecords = [record, { mesh: { isSkinnedMesh: false } }];
assert.equal(record.weightGeometry, null);
weightsViewer.applyWeightMaterials();
assert.deepEqual(Array.from(record.weightGeometry.getAttribute("color").array), [0.25, 0.75, 0, 0, 1, 0]);
const firstWeightGeometry = record.weightGeometry;
weightsViewer.restoreMeshMaterials();
weightsViewer.applyWeightMaterials();
assert.equal(record.weightGeometry, firstWeightGeometry);
assert.equal(record.mesh.geometry, firstWeightGeometry);
console.log("PASS: Weights produces normalized colors on first use and reuses the same geometry on subsequent switches.");

const overlayHarness = harness();
class OverlayResource {
  constructor(options) { Object.assign(this, options); this.disposeCount = 0; }
  dispose() { this.disposeCount++; }
}
Object.assign(overlayHarness.context.THREE, {
  Group: class {
    constructor() { this.children = []; }
    add(child) { this.children.push(child); }
    remove(child) { this.children = this.children.filter((entry) => entry !== child); }
  },
  Mesh: class { constructor(geometry, material) { Object.assign(this, { geometry, material }); } },
  MeshStandardMaterial: OverlayResource,
  SphereGeometry: OverlayResource,
  CylinderGeometry: OverlayResource,
  Color: class {
    constructor(value) { this.value = value; }
    clone() { return new this.constructor(this.value); }
    multiplyScalar() { return this; }
  },
});
const boneButtons = [
  { mode: "mesh" }, { mode: "skeleton", group: "body" },
  { mode: "skeleton", group: "hair" }, { mode: "weights" },
].map((dataset) => ({
  dataset, attributes: {}, active: false,
  classList: { toggle(name, active) { this.active = active; } },
  setAttribute(name, value) { this.attributes[name] = value; },
}));
const bodyBone = { uuid: "body", isBone: true };
const hairBone = { uuid: "hair", isBone: true, parent: bodyBone };
const overlays = Object.create(overlayHarness.RigViewer.prototype);
Object.assign(overlays, {
  mode: "mesh", activeGroups: new Set(), meshRecords: [],
  skeletonVisual: null, skeletonResources: null, skeletonJoints: [], skeletonSegments: [],
  boneRecords: [{ bone: bodyBone, group: "body" }, { bone: hairBone, group: "hair" }],
  scene: new overlayHarness.context.THREE.Group(),
  modelRoot: { visible: true, updateMatrixWorld() {} },
  controlsElement: { querySelectorAll: () => boneButtons },
  updateSkeletonVisualPositions() {},
});
const activeBones = () => boneButtons.filter((button) => button.attributes["aria-pressed"] === "true")
  .map((button) => button.dataset.group || button.dataset.mode);
const assertDisposed = (resources) => resources.forEach((group) => {
  Object.values(group).forEach((resource) => assert.equal(resource.disposeCount, 1));
});
overlays.setMode("skeleton", "body");
const bodyResources = overlays.skeletonResources;
assert.deepEqual(activeBones(), ["body"]);
overlays.setMode("skeleton", "hair");
assertDisposed(bodyResources);
assert.deepEqual(activeBones(), ["body", "hair"]);
assert.equal(overlays.scene.children.length, 1);
assert.equal(overlays.skeletonResources.length, 2);
assert.equal(overlays.skeletonJoints.length, 3);
assert.equal(overlays.skeletonSegments.length, 1);
assert.notEqual(overlays.skeletonResources[0].boneMaterial.color.value,
  overlays.skeletonResources[1].boneMaterial.color.value);
const bothResources = overlays.skeletonResources;
overlays.setMode("skeleton", "body");
assertDisposed(bothResources);
assert.deepEqual(activeBones(), ["hair"]);
assert.equal(overlays.skeletonSegments[0].bone, hairBone);
assert.equal(overlays.skeletonSegments[0].parentBone, bodyBone);
const hairResources = overlays.skeletonResources;
overlays.setMode("skeleton", "hair");
assertDisposed(hairResources);
assert.deepEqual(activeBones(), ["mesh"]);
assert.equal(overlays.scene.children.length, 0);
assert.equal(overlays.skeletonJoints.length, 0);
overlays.setMode("skeleton", "body");
overlays.setMode("skeleton", "hair");
const beforeWeights = overlays.skeletonResources;
overlays.setMode("weights");
assertDisposed(beforeWeights);
assert.deepEqual(activeBones(), ["weights"]);
assert.equal(overlays.activeGroups.size, 0);
assert.equal(overlays.skeletonVisual, null);
overlays.setMode("skeleton", "hair");
assert.deepEqual(activeBones(), ["hair"]);
overlays.setMode("skeleton", "missing");
assert.deepEqual(activeBones(), ["hair"]);
const beforeMesh = overlays.skeletonResources;
overlays.setMode("mesh");
assertDisposed(beforeMesh);
assert.deepEqual(activeBones(), ["mesh"]);
assert.equal(overlays.activeGroups.size, 0);
assert.equal(overlays.scene.children.length, 0);
console.log("PASS: multiple bone groups keep independent colors and pressed states; deselecting one preserves the others; Mesh/Weights clear overlays and dispose every group's resources exactly once.");

const lifecycle = Object.create(h.RigViewer.prototype);
const loopCalls = [];
Object.assign(lifecycle, {
  isVisible: true, isInitialized: true, renderer: { setAnimationLoop: (callback) => loopCalls.push(callback) },
  orbitControls: {}, renderFrame() {}, init() {},
});
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
lifecycle.setVisible(false);
assert.equal(loopCalls.at(-1), null);
assert.equal(h.timers.get(lifecycle.releaseTimer).delay, 10000);
lifecycle.setVisible(true);
assert.equal(h.idleViewers.has(lifecycle), false);
assert.equal(lifecycle.releaseTimer, null);
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
h.document.hidden = true;
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), null);
assert.equal(lifecycle.orbitControls.enabled, false);
h.document.hidden = false;
lifecycle.updatePlayback();
assert.equal(loopCalls.at(-1), lifecycle.renderFrame);
assert.equal(lifecycle.lastFrameTime, null);

const idle = Array.from({ length: 4 }, () => ({
  isVisible: false, renderer: {}, destroyed: false,
  destroy() { this.destroyed = true; h.idleViewers.delete(this); h.context.window.clearTimeout(this.releaseTimer); },
}));
idle.forEach(h.retainIdleViewer);
assert.equal(h.idleViewers.size, 3);
assert.equal(idle[0].destroyed, true);
assert.equal(idle[3].destroyed, false);
h.timers.get(idle[3].releaseTimer).callback();
assert.equal(idle[3].destroyed, true);
console.log("PASS: offscreen and background viewers stop rendering immediately; return resumes; only three idle cards remain and expire after ten seconds.");

const prefetchViewer = Object.create(h.RigViewer.prototype);
Object.assign(prefetchViewer, { isVisible: false, isNearViewport: false, isInitialized: false, isLoading: false, isQueued: false });
let loadStarted = 0;
prefetchViewer.startLoading = async () => { loadStarted++; };
prefetchViewer.setNearViewport(true);
assert.equal(loadStarted, 1);
assert.equal(prefetchViewer.isVisible, false);
await new Promise((resolve) => setImmediate(resolve));
h.document.hidden = true;
prefetchViewer.init();
assert.equal(loadStarted, 1);
h.document.hidden = false;
h.processViewerLoadQueue();
assert.equal(loadStarted, 2);
console.log("PASS: prefetch can load without playing; background tabs defer queued loads until visible.");

const inactive = Object.create(h.RigViewer.prototype);
let inactiveLoads = 0;
Object.assign(inactive, {
  isEnabled: false, isVisible: false, isNearViewport: false,
  isInitialized: false, isLoading: false, isQueued: false,
  startLoading: async () => { inactiveLoads++; },
});
inactive.setNearViewport(true);
inactive.setVisible(true);
assert.equal(inactiveLoads, 0);
assert.equal(inactive.isVisible, false);
assert.equal(inactive.isNearViewport, false);
inactive.setEnabled(true);
inactive.setNearViewport(true);
assert.equal(inactiveLoads, 1);
await new Promise((resolve) => setImmediate(resolve));

lifecycle.isEnabled = true;
lifecycle.isVisible = true;
lifecycle.isQueued = true;
h.viewerLoadQueue.push(lifecycle);
lifecycle.setEnabled(false);
assert.equal(loopCalls.at(-1), null);
assert.equal(lifecycle.isNearViewport, false);
assert.equal(lifecycle.isQueued, false);
assert.equal(h.viewerLoadQueue.includes(lifecycle), false);
lifecycle.setVisible(true);
assert.equal(lifecycle.isVisible, false);
let canceledLoad = false;
inactive.isLoading = true;
inactive.destroy = () => { canceledLoad = true; };
inactive.setEnabled(false);
assert.equal(canceledLoad, true);
console.log("PASS: inactive character rows cannot load or play, including stale visibility callbacks; switching removes queued loads and cancels unfinished loads.");

function comparison(h, durations, dataset = {}) {
  const group = new h.AnimationPlaybackGroup({ dataset });
  const requests = [];
  const completions = new Map();
  const makeRenderer = (viewer) => ({ setAnimationLoop: (callback) => { viewer.loop = callback; } });
  group.viewers = durations.map((duration, index) => {
    const viewer = Object.create(h.RigViewer.prototype);
    Object.assign(viewer, {
      animationGroup: group, isEnabled: true, isNearViewport: index === 0,
      isVisible: index < 2, isInitialized: false, isLoading: false, isQueued: false,
      hasLoadError: false, releaseTimer: null, loop: null, orbitControls: {},
      status: { hidden: false, textContent: "Loading animation…" },
      card: { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } },
      renderFrame() {},
      startLoading() {
        this.isLoading = true;
        this.renderer = makeRenderer(this);
        requests.push(index);
        return new Promise((resolve) => {
          completions.set(index, (error = false) => {
            completions.delete(index);
            this.isLoading = false;
            this.isInitialized = true;
            this.hasLoadError = error;
            this.animationClip = error ? null : { duration };
            this.mixer = error ? null : { time: 0, setTime(time) { this.time = time; } };
            if (error) this.status.textContent = "Unable to load this model.";
            group.update();
            resolve();
          });
        });
      },
      destroy() {
        h.idleViewers.delete(this);
        h.context.window.clearTimeout(this.releaseTimer);
        this.releaseTimer = null;
        this.renderer = null;
        this.loop = null;
        this.isInitialized = false;
        this.animationClip = null;
        this.mixer = null;
        group.update();
      },
    });
    return viewer;
  });
  return { group, requests, completions };
}

const sync = harness();
const row = comparison(sync, [4.58, 3.75, 3.75, 3.75, 3.75]);
row.group.update();
assert.deepEqual(row.requests, [0, 1]);
assert.equal(sync.viewerLoadQueue.length, 3);
for (let index = 0; index < 5; index++) {
  sync.setNow((index + 1) * 100);
  assert.ok(row.completions.has(index));
  row.completions.get(index)();
  await new Promise((resolve) => setImmediate(resolve));
  if (index < 4) {
    assert.equal(row.group.isPlaying, false);
    assert.ok(row.group.viewers.every((viewer) => viewer.loop === null));
    assert.match(row.group.viewers[0].status.textContent, /Waiting for other models/);
    assert.equal(row.group.viewers[0].mixer.time, 0);
  }
}
assert.deepEqual(row.requests, [0, 1, 2, 3, 4]);
assert.equal(row.group.ready, true);
assert.equal(row.group.isPlaying, true);
assert.equal(row.group.loopDuration, 3.75);
assert.equal(row.group.panel.dataset.readyCount, "5");
assert.ok(row.group.viewers.every((viewer) => viewer.status.hidden));
assert.equal(row.group.viewers[0].loop, row.group.viewers[0].renderFrame);
assert.equal(row.group.viewers[4].loop, null);
row.group.viewers.forEach(sync.retainIdleViewer);
assert.equal(sync.idleViewers.size, 0);
assert.equal(row.group.timeAt(500), 0);
assert.equal(row.group.timeAt(4249), 3.749);
assert.equal(row.group.timeAt(4250), 0);
assert.ok(Math.abs(row.group.timeAt(4350) - 0.1) < 1e-12);
console.log("PASS: staggered two-at-a-time loads include offscreen methods; none plays early; the entire row loops at the shortest clip duration without changing speed or being evicted.");

sync.setNow(1500);
row.group.viewers[4].setVisible(true);
assert.equal(row.group.viewers[4].loop, row.group.viewers[4].renderFrame);
assert.equal(row.group.timeAt(1600), 1.1);
sync.setNow(2000);
sync.document.hidden = true;
row.group.update();
assert.equal(row.group.timeAt(10000), 1.5);
assert.ok(row.group.viewers.every((viewer) => viewer.loop === null));
sync.setNow(10000);
sync.document.hidden = false;
row.group.update();
assert.equal(row.group.timeAt(10500), 2);
sync.setNow(10500);
row.group.viewers.forEach((viewer) => { viewer.isVisible = false; });
row.group.update();
assert.equal(row.group.timeAt(20000), 2);
sync.setNow(20000);
row.group.viewers[0].setVisible(true);
assert.equal(row.group.timeAt(20500), 2.5);
assert.equal(row.group.timeAt(21750), 0);
console.log("PASS: horizontally revealed cards join the shared phase; background and fully offscreen rows pause together and resume without drift across loop boundaries.");

sync.setNow(22000);
row.group.viewers.forEach((viewer) => {
  viewer.isEnabled = false;
  viewer.isVisible = false;
  viewer.isNearViewport = false;
});
row.group.update();
assert.equal(row.group.isPlaying, false);
assert.equal(row.group.timeAt(23000), 0);
assert.equal(sync.idleViewers.size, 3);
assert.equal(row.group.viewers.filter((viewer) => !viewer.isInitialized).length, 2);
row.group.viewers.forEach((viewer) => { viewer.isEnabled = true; });
row.group.viewers[0].isVisible = true;
row.group.viewers[0].isNearViewport = true;
row.group.update();
assert.equal(row.group.isPlaying, false);
assert.equal(sync.idleViewers.size, 0);
sync.setNow(23000);
row.completions.get(0)();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(row.group.isPlaying, false);
sync.setNow(24000);
row.completions.get(1)();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(row.group.isPlaying, true);
assert.equal(row.group.timeAt(24000), 0);
assert.equal(row.group.timeAt(24500), 0.5);
console.log("PASS: switching characters resets the row clock; returning after partial cache eviction waits for replacements and restarts every method together.");

const missing = harness();
const fox = comparison(missing, [3.79, 3.79, 3.79, 3.79]);
fox.group.update();
for (let index = 0; index < 4; index++) {
  missing.setNow((index + 1) * 100);
  fox.completions.get(index)(index === 1);
  await new Promise((resolve) => setImmediate(resolve));
  if (index < 3) assert.equal(fox.group.isPlaying, false);
}
assert.equal(fox.group.panel.dataset.readyCount, "4");
assert.equal(fox.group.isPlaying, true);
assert.equal(fox.group.viewers[1].loop, null);
assert.equal(fox.group.viewers[1].status.hidden, false);
assert.equal(fox.group.viewers[1].status.textContent, "Unable to load this model.");
assert.equal(fox.group.viewers[0].loop, fox.group.viewers[0].renderFrame);
console.log("PASS: missing method placeholders are excluded; a failed load retains its error and does not leave successful comparisons waiting forever.");

const homepage = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const resultsPanel = homepage.match(/<div\b[^>]*\bid="animation-results-grid"[^>]*>/)?.[0];
const playbackLimit = resultsPanel?.match(/\bdata-playback-limit="([^"]+)"/)?.[1];
assert.equal(playbackLimit, "7");
assert.equal((homepage.match(/\bdata-playback-limit=/g) || []).length, 1);
const limited = harness();
const results = comparison(limited, [10.29, 10.29, 10.29, 10.29, 10.29, 13], { playbackLimit });
results.group.update();
for (let index = 0; index < 6; index++) {
  limited.setNow((index + 1) * 100);
  results.completions.get(index)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results.group.isPlaying, index === 5);
}
assert.equal(results.group.loopDuration, 7);
assert.equal(results.group.timeAt(600), 0);
assert.equal(results.group.timeAt(7599), 6.999);
assert.equal(results.group.timeAt(7600), 0);
assert.ok(Math.abs(results.group.timeAt(7800) - 0.2) < 1e-12);
assert.equal(results.group.timeAt(14600), 0);
for (let timestamp = 600; timestamp < 100000; timestamp += 17) {
  const phase = results.group.timeAt(timestamp);
  assert.ok(phase >= 0 && phase < 7, `Frame at ${timestamp}ms escaped the seven-second limit`);
}
limited.setNow(7500);
limited.document.hidden = true;
results.group.update();
assert.equal(results.group.timeAt(20000), 6.9);
limited.setNow(20000);
limited.document.hidden = false;
results.group.update();
assert.equal(results.group.timeAt(20100), 0);
assert.equal(results.group.timeAt(27100), 0);
// A cap must never extend a shorter source clip or cap an unconfigured panel.
results.group.viewers[0].animationClip.duration = 5;
results.group.update();
assert.equal(results.group.loopDuration, 5);
const uncapped = comparison(harness(), [10.29, 13]);
uncapped.group.viewers.forEach((viewer, index) => {
  viewer.isInitialized = true;
  viewer.animationClip = { duration: index === 0 ? 10.29 : 13 };
  viewer.renderer = { setAnimationLoop() {} };
});
uncapped.group.update();
assert.equal(uncapped.group.loopDuration, 10.29);
console.log("PASS: the six Animation Results wait for all loads, play only [0, 7) seconds at original speed, wrap together even after delayed frames or background pauses, and leave comparison durations unchanged.");
