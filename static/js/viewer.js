import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { fingerprintModel, readModelBounds, saveModelBounds } from "./viewer-cache.js?v=20261009-1";
import {
  BONE_KEYWORDS,
  classifyBone,
  loadBoneLabelsForModel,
  semanticBoneName,
} from "./bone-labels.js?v=20260904-1";

const loader = new GLTFLoader();
const CLAY_COLOR = 0xb8bec8;
const CLAY_ROUGHNESS = 0.82;
const MODEL_TARGET_SIZE = 2.25;
const CAMERA_PADDING = 1.14;
const NORMAL_CREASE_COSINE = Math.cos(THREE.MathUtils.degToRad(52));

const BONE_GROUP_COLORS = Object.freeze({
  body: { bone: 0x0e0eff, joint: 0x66d5d8 },
  skirt: { bone: 0xd91426, joint: 0xff736b },
  hair: { bone: 0xff268c, joint: 0xff8cc7 },
  sleeve: { bone: 0x0dff73, joint: 0x8cffbf },
  cape: { bone: 0x8c26d9, joint: 0xc78cfa },
  accessory: { bone: 0x8cf21a, joint: 0xccff73 },
  collar: { bone: 0xec4899, joint: 0xf7a8d0 },
  correction: { bone: 0xff801a, joint: 0xffb873 },
  face: { bone: 0xffd91a, joint: 0xffed8c },
  muscle: { bone: 0xf97316, joint: 0xfcb079 },
  twist: { bone: 0x1ad9f2, joint: 0x8cedff },
});
const DEFAULT_BONE_GROUP_COLOR = Object.freeze({ bone: 0x64748b, joint: 0x94a3b8 });
const JOINT_RADIUS = 0.027;
const BONE_RADIUS = 0.012;
const CYLINDER_UP_AXIS = new THREE.Vector3(0, 1, 0);
const INITIAL_VIEW_DIRECTION = new THREE.Vector3(0.82, 0.24, 1.4).normalize();
const VIEWER_RELEASE_DELAY = 10000;
const MAX_IDLE_VIEWERS = 3;
const MAX_CONCURRENT_VIEWER_LOADS = 2;
const viewerLoadQueue = [];
const idleViewers = new Map();
const viewers = [];
let activeViewerLoads = 0;

function processViewerLoadQueue() {
  if (document.hidden) return;
  // Actual onscreen cards take priority over cards being prepared ahead of time.
  viewerLoadQueue.sort((a, b) => Number(b.isVisible) - Number(a.isVisible));
  while (activeViewerLoads < MAX_CONCURRENT_VIEWER_LOADS && viewerLoadQueue.length > 0) {
    const viewer = viewerLoadQueue.shift();
    viewer.isQueued = false;

    if (viewer.isEnabled === false || !viewer.isNearViewport || viewer.isInitialized || viewer.isLoading) {
      continue;
    }

    activeViewerLoads += 1;
    viewer.startLoading().finally(() => {
      activeViewerLoads -= 1;
      processViewerLoadQueue();
    });
  }
}

function retainIdleViewer(viewer) {
  if (viewer.isVisible || !viewer.renderer) return;
  idleViewers.delete(viewer);
  idleViewers.set(viewer, true);
  window.clearTimeout(viewer.releaseTimer);
  viewer.releaseTimer = window.setTimeout(() => viewer.destroy(), VIEWER_RELEASE_DELAY);
  while (idleViewers.size > MAX_IDLE_VIEWERS) {
    idleViewers.keys().next().value.destroy();
  }
}

async function loadModel(url, signal) {
  const absoluteUrl = new URL(url, window.location.href).href;
  const response = await fetch(absoluteUrl, { signal });
  if (!response.ok) throw new Error(`Unable to load model: ${response.status}`);
  const bytes = await response.arrayBuffer();
  const [gltf, fingerprint] = await Promise.all([
    loader.parseAsync(bytes, new URL(".", absoluteUrl).href),
    fingerprintModel(bytes),
  ]);
  return { gltf, fingerprint, absoluteUrl };
}

function queueViewerLoad(viewer) {
  viewerLoadQueue.push(viewer);
  processViewerLoadQueue();
}

function collectMaterialResources(material, materials, textures) {
  materialList(material).forEach((entry) => {
    if (!entry || materials.has(entry)) {
      return;
    }

    materials.add(entry);
    Object.values(entry).forEach((value) => {
      if (value?.isTexture) {
        textures.add(value);
      }
    });
  });
}

function disposeObjectResources(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const skeletons = new Set();

  root?.traverse((object) => {
    if (object.geometry) {
      geometries.add(object.geometry);
    }
    if (object.material) {
      collectMaterialResources(object.material, materials, textures);
    }
    if (object.skeleton) skeletons.add(object.skeleton);
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
  skeletons.forEach((skeleton) => skeleton.dispose());
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function colorForBone(name, fallbackIndex = 0) {
  const value = String(name || `bone-${fallbackIndex}`);
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const hue = ((hash >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.78, 0.56);
}

function paletteForGroup(group) {
  return BONE_GROUP_COLORS[group] ?? DEFAULT_BONE_GROUP_COLOR;
}

function colorForGroup(group, part = "bone") {
  const palette = paletteForGroup(group);
  return new THREE.Color(palette[part] ?? palette.bone);
}

function createClayMaterial() {
  return new THREE.MeshStandardMaterial({
    color: CLAY_COLOR,
    metalness: 0,
    roughness: CLAY_ROUGHNESS,
    side: THREE.FrontSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    vertexColors: false,
  });
}

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function materialHasTexture(material) {
  return materialList(material).some((entry) => (
    entry && Object.values(entry).some((value) => value?.isTexture)
  ));
}

function cloneMaterial(material) {
  if (Array.isArray(material)) {
    return material.map((entry) => entry.clone());
  }

  return material.clone();
}

// Several exported examples contain a separate vertex normal for almost every
// triangle. Average normals only across coincident vertices whose source normals
// already point in a similar direction, preserving intentional creases while
// removing the faceted/rippled shading caused by split export normals.
function createSmoothedGeometry(sourceGeometry) {
  const geometry = sourceGeometry.clone();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");

  if (!position) {
    return geometry;
  }

  if (!normal) {
    geometry.computeVertexNormals();
    return geometry;
  }

  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox
    .getSize(new THREE.Vector3())
    .length();
  const quantization = Math.max(diagonal * 1e-6, 1e-7);
  const positionGroups = new Map();

  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    const key = [
      Math.round(position.getX(vertexIndex) / quantization),
      Math.round(position.getY(vertexIndex) / quantization),
      Math.round(position.getZ(vertexIndex) / quantization),
    ].join(":");
    const group = positionGroups.get(key);

    if (group) {
      group.push(vertexIndex);
    } else {
      positionGroups.set(key, [vertexIndex]);
    }
  }

  const smoothedNormals = new Float32Array(normal.count * 3);
  const referenceNormal = new THREE.Vector3();
  const candidateNormal = new THREE.Vector3();
  const averagedNormal = new THREE.Vector3();

  positionGroups.forEach((vertexIndices) => {
    vertexIndices.forEach((vertexIndex) => {
      referenceNormal.fromBufferAttribute(normal, vertexIndex).normalize();
      averagedNormal.set(0, 0, 0);

      vertexIndices.forEach((candidateIndex) => {
        candidateNormal.fromBufferAttribute(normal, candidateIndex).normalize();
        if (referenceNormal.dot(candidateNormal) >= NORMAL_CREASE_COSINE) {
          averagedNormal.add(candidateNormal);
        }
      });

      if (averagedNormal.lengthSq() <= Number.EPSILON) {
        averagedNormal.copy(referenceNormal);
      } else {
        averagedNormal.normalize();
      }

      averagedNormal.toArray(smoothedNormals, vertexIndex * 3);
    });
  });

  geometry.setAttribute("normal", new THREE.BufferAttribute(smoothedNormals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function boxCorners(box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function fitDistanceForBox(box, camera, direction) {
  const center = box.getCenter(new THREE.Vector3());
  const right = new THREE.Vector3()
    .crossVectors(camera.up, direction)
    .normalize();
  const screenUp = new THREE.Vector3()
    .crossVectors(direction, right)
    .normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.01),
  );
  const verticalTangent = Math.tan(verticalHalfFov);
  const horizontalTangent = Math.tan(horizontalHalfFov);
  let requiredDistance = 0;

  boxCorners(box).forEach((corner) => {
    const offset = corner.sub(center);
    const depthTowardCamera = offset.dot(direction);
    const horizontalExtent = Math.abs(offset.dot(right));
    const verticalExtent = Math.abs(offset.dot(screenUp));

    requiredDistance = Math.max(
      requiredDistance,
      depthTowardCamera + (horizontalExtent * CAMERA_PADDING) / horizontalTangent,
      depthTowardCamera + (verticalExtent * CAMERA_PADDING) / verticalTangent,
    );
  });

  return Math.max(requiredDistance, 0.01);
}

class RigViewer {
  constructor(card) {
    this.card = card;
    this.modelUrl = card.dataset.model;
    this.stage = card.querySelector(".viewer-stage");
    this.canvas = card.querySelector(".rig-canvas");
    this.status = card.querySelector(".viewer-status");
    this.controlsElement = card.querySelector(".viewer-controls");
    this.boneButtonHost = card.querySelector(".bone-mode-buttons");

    this.mode = "mesh";
    this.activeGroup = null;
    this.model = null;
    this.modelRoot = null;
    this.ground = null;
    this.skeletonVisual = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
    this.meshRecords = [];
    this.boneRecords = [];
    this.hasTextureMaterial = false;
    this.mixer = null;
    this.animationAction = null;
    this.isVisible = false;
    this.isEnabled = card.dataset.viewerEnabled !== "false";
    this.isNearViewport = false;
    this.boundsCacheUrl = null;
    this.modelFingerprint = null;
    this.hasUserFramedView = false;
    this.fittedBox = null;
    this.lastFrameTime = null;
    this.isInitialized = false;
    this.isLoading = false;
    this.isQueued = false;
    this.loadGeneration = 0;
    this.releaseTimer = null;
    this.loadAbort = null;

    this.setupControlEvents();
  }

  init() {
    if (this.isEnabled === false || this.isInitialized || this.isLoading || this.isQueued) {
      return;
    }

    this.isQueued = true;
    queueViewerLoad(this);
  }

  async startLoading() {
    if (this.isEnabled === false || !this.isNearViewport || this.isInitialized || this.isLoading) {
      return;
    }

    this.isLoading = true;
    this.loadAbort = new AbortController();
    const loadGeneration = ++this.loadGeneration;
    this.status.hidden = false;
    this.status.textContent = this.card.dataset.animation
      ? "Loading animation…"
      : "Loading 3D model…";
    this.status.classList.remove("is-error");

    try {
      this.setupScene();
      this.setupObservers();
      retainIdleViewer(this);
      const [{ gltf, fingerprint, absoluteUrl }, boneLabels] = await Promise.all([
        loadModel(this.modelUrl, this.loadAbort.signal),
        loadBoneLabelsForModel(this.modelUrl),
      ]);
      if (loadGeneration !== this.loadGeneration) {
        disposeObjectResources(gltf.scene);
        return;
      }

      this.model = gltf.scene;
      this.boundsCacheUrl = absoluteUrl;
      this.modelFingerprint = fingerprint;
      this.modelRoot = new THREE.Group();
      this.modelRoot.add(this.model);
      this.scene.add(this.modelRoot);

      this.prepareModel(boneLabels);
      this.prepareAnimation(gltf.animations);
      this.fitModelToStage();
      this.buildTextureButton();
      this.buildBoneButtons();
      this.enableControls();
      this.status.hidden = true;
      this.card.classList.remove("is-loading");
      this.card.setAttribute("aria-busy", "false");
      this.isInitialized = true;
    } catch (error) {
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      console.error(`Unable to load ${this.modelUrl}`, error);
      this.status.textContent = "Unable to load this model.";
      this.status.classList.add("is-error");
      this.card.classList.remove("is-loading");
      this.card.setAttribute("aria-busy", "false");
      this.isInitialized = true;
    } finally {
      if (loadGeneration === this.loadGeneration) {
        this.isLoading = false;
        this.loadAbort = null;
        this.updatePlayback();
        retainIdleViewer(this);
      }
    }
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f5f8);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas: this.canvas,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 2.35);
    this.scene.add(hemisphereLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.35);
    keyLight.position.set(3.5, 5, 4.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1536, 1536);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.normalBias = 0.035;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc9dcff, 1.2);
    fillLight.position.set(-4, 2, -3);
    this.scene.add(fillLight);

    this.orbitControls = new OrbitControls(this.camera, this.canvas);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.055;
    this.orbitControls.enablePan = false;
    this.orbitControls.autoRotate = true;
    this.orbitControls.autoRotateSpeed = 0.65;
    this.orbitControls.target.set(0, 0, 0);
    this.orbitControls.addEventListener("start", () => {
      this.hasUserFramedView = true;
    });

    this.renderFrame = (time) => {
      const delta = this.lastFrameTime === null
        ? 0
        : Math.min((time - this.lastFrameTime) / 1000, 0.1);
      this.lastFrameTime = time;

      if (!this.isVisible || document.hidden) {
        return;
      }

      if (this.mixer) {
        this.mixer.update(delta);
      }

      if (this.skeletonVisual) {
        this.modelRoot.updateMatrixWorld(true);
        this.updateSkeletonVisualPositions();
      }

      this.orbitControls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.updatePlayback();
  }

  setupObservers() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resize();
  }

  setEnabled(isEnabled) {
    if (this.isEnabled === isEnabled) return;
    this.isEnabled = isEnabled;
    if (!isEnabled) {
      this.setVisible(false);
      this.isNearViewport = false;
      const queueIndex = viewerLoadQueue.indexOf(this);
      if (queueIndex !== -1) viewerLoadQueue.splice(queueIndex, 1);
      this.isQueued = false;
      if (this.isLoading) this.destroy();
    }
  }

  setVisible(isVisible) {
    isVisible = isVisible && this.isEnabled !== false;
    this.isVisible = isVisible;
    this.updatePlayback();

    if (isVisible) {
      this.isNearViewport = true;
      idleViewers.delete(this);
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      this.init();
      return;
    }

    if (!this.isInitialized && !this.isLoading) {
      return;
    }

    retainIdleViewer(this);
  }

  setNearViewport(isNearViewport) {
    this.isNearViewport = this.isEnabled !== false && (isNearViewport || this.isVisible);
    if (this.isNearViewport) this.init();
  }

  updatePlayback() {
    const playing = this.isEnabled !== false && this.isVisible && !document.hidden && this.isInitialized;
    this.lastFrameTime = null;
    this.renderer?.setAnimationLoop(playing ? this.renderFrame : null);
    if (this.orbitControls) this.orbitControls.enabled = playing;
  }

  destroy() {
    idleViewers.delete(this);
    this.loadAbort?.abort();
    this.loadAbort = null;
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.loadGeneration += 1;
    this.isLoading = false;
    this.isQueued = false;
    this.isInitialized = false;
    this.isVisible = false;
    const queueIndex = viewerLoadQueue.indexOf(this);
    if (queueIndex !== -1) viewerLoadQueue.splice(queueIndex, 1);

    this.renderer?.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.orbitControls?.dispose();
    this.clearSkeletonVisual();

    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const skeletons = new Set();
    this.meshRecords.forEach((record) => {
      if (record.mesh.skeleton) skeletons.add(record.mesh.skeleton);
      [record.displayGeometry, record.weightGeometry].forEach((geometry) => {
        if (geometry) {
          geometries.add(geometry);
        }
      });
      [record.displayMaterial, record.textureMaterial, record.weightMaterial].forEach((material) => {
        if (material) {
          collectMaterialResources(material, materials, textures);
        }
      });
    });
    if (this.ground) {
      geometries.add(this.ground.geometry);
      collectMaterialResources(this.ground.material, materials, textures);
    }

    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    skeletons.forEach((skeleton) => skeleton.dispose());

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }

    this.mixer?.stopAllAction();
    if (this.mixer && this.model) {
      this.mixer.uncacheRoot(this.model);
    }

    this.controlsElement.querySelector('[data-mode="texture"]')?.remove();
    this.boneButtonHost.replaceChildren();
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      button.disabled = true;
      const isMesh = button.dataset.mode === "mesh";
      button.classList.toggle("is-active", isMesh);
      button.setAttribute("aria-pressed", String(isMesh));
    });

    const replacementCanvas = this.canvas.cloneNode(false);
    this.canvas.replaceWith(replacementCanvas);
    this.canvas = replacementCanvas;
    this.status.hidden = false;
    this.status.textContent = this.card.dataset.animation
      ? "Loading animation…"
      : "Loading 3D model…";
    this.status.classList.remove("is-error");
    this.card.classList.add("is-loading");
    this.card.setAttribute("aria-busy", "true");

    this.mode = "mesh";
    this.activeGroup = null;
    this.model = null;
    this.modelRoot = null;
    this.ground = null;
    this.skeletonVisual = null;
    this.meshRecords = [];
    this.boneRecords = [];
    this.hasTextureMaterial = false;
    this.mixer = null;
    this.animationClip = null;
    this.animationAction = null;
    this.fittedBox = null;
    this.boundsCacheUrl = null;
    this.modelFingerprint = null;
    this.hasUserFramedView = false;
    this.lastFrameTime = null;
    this.renderer = null;
    this.renderFrame = null;
    this.scene = null;
    this.camera = null;
    this.orbitControls = null;
    this.resizeObserver = null;
  }

  resize() {
    const width = Math.max(1, this.stage.clientWidth);
    const height = Math.max(1, this.stage.clientHeight);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.fittedBox && !this.hasUserFramedView) {
      this.frameCameraToBox(this.fittedBox);
    }
  }

  setupControlEvents() {
    this.controlsElement.addEventListener("click", (event) => {
      const button = event.target.closest(".viewer-mode");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.mode === "skeleton") {
        this.setMode("skeleton", button.dataset.group);
      } else {
        this.setMode(button.dataset.mode);
      }
    });

  }

  prepareModel(boneLabels) {
    const seenBones = new Set();

    this.model.traverse((object) => {
      if (!object.isMesh) {
        return;
      }

      object.castShadow = true;
      object.receiveShadow = true;

      const sourceMaterial = object.material;
      const sourceGeometry = object.geometry;
      const textureMaterial = cloneMaterial(sourceMaterial);
      const hasTexture = materialHasTexture(sourceMaterial);
      const displayGeometry = createSmoothedGeometry(sourceGeometry);
      const displayMaterial = createClayMaterial();

      object.geometry = displayGeometry;
      object.material = displayMaterial;
      sourceGeometry.dispose();
      this.hasTextureMaterial ||= hasTexture;
      this.meshRecords.push({
        mesh: object,
        displayGeometry,
        displayMaterial,
        textureMaterial,
        hasTexture,
        weightGeometry: null,
        weightMaterial: null,
        boneColors: object.isSkinnedMesh
          ? object.skeleton.bones.map((bone, index) => colorForBone(bone.name, index))
          : null,
      });

      if (!object.isSkinnedMesh) {
        return;
      }

      object.skeleton.bones.forEach((bone) => {
        if (seenBones.has(bone.uuid)) {
          return;
        }

        seenBones.add(bone.uuid);
        const semanticName = semanticBoneName(bone.name, boneLabels);
        this.boneRecords.push({
          bone,
          group: classifyBone(semanticName),
          semanticName,
        });
      });
    });
  }

  prepareAnimation(animations) {
    const clip = animations?.[0];
    if (!clip) {
      return;
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    this.animationClip = clip;
    this.animationAction = this.mixer.clipAction(clip);
    this.animationAction.setLoop(THREE.LoopRepeat, Infinity);
    this.animationAction.play();
    this.mixer.update(0);
  }

  createWeightGeometry(skinnedMesh, displayGeometry, boneColors) {
    const geometry = displayGeometry.clone();
    const position = geometry.getAttribute("position");
    const skinIndex = geometry.getAttribute("skinIndex");
    const skinWeight = geometry.getAttribute("skinWeight");
    const colors = new Float32Array(position.count * 3);
    const fallbackColors = new Map();
    const channelGetters = ["getX", "getY", "getZ", "getW"];

    if (!skinIndex || !skinWeight) {
      colors.fill(0.72);
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      return geometry;
    }

    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let totalWeight = 0;

      for (const getter of channelGetters) {
        const weight = skinWeight[getter](vertexIndex);
        if (weight <= 0) {
          continue;
        }

        const boneIndex = Math.round(skinIndex[getter](vertexIndex));
        let boneColor = boneColors[boneIndex];
        if (!boneColor) {
          if (!fallbackColors.has(boneIndex)) fallbackColors.set(boneIndex, colorForBone(null, boneIndex));
          boneColor = fallbackColors.get(boneIndex);
        }

        red += boneColor.r * weight;
        green += boneColor.g * weight;
        blue += boneColor.b * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        red /= totalWeight;
        green /= totalWeight;
        blue /= totalWeight;
      } else {
        red = 0.65;
        green = 0.65;
        blue = 0.65;
      }

      const colorOffset = vertexIndex * 3;
      colors[colorOffset] = red;
      colors[colorOffset + 1] = green;
      colors[colorOffset + 2] = blue;
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  fitModelToStage() {
    this.modelRoot.updateMatrixWorld(true);

    const initialBox = this.computeContentBounds();
    const center = initialBox.getCenter(new THREE.Vector3());
    const size = initialBox.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z) || 1;
    const scale = MODEL_TARGET_SIZE / largestDimension;

    this.modelRoot.scale.setScalar(scale);
    this.modelRoot.position.copy(center).multiplyScalar(-scale);
    this.modelRoot.updateMatrixWorld(true);

    this.fittedBox = initialBox.clone();
    this.fittedBox.min.multiplyScalar(scale).add(this.modelRoot.position);
    this.fittedBox.max.multiplyScalar(scale).add(this.modelRoot.position);
    this.frameCameraToBox(this.fittedBox);
    this.createGround(this.fittedBox);
  }

  computeContentBounds() {
    const saved = readModelBounds(this.boundsCacheUrl, this.modelFingerprint);
    if (saved) {
      return new THREE.Box3(
        new THREE.Vector3().fromArray(saved.min),
        new THREE.Vector3().fromArray(saved.max),
      );
    }
    const bounds = this.calculateContentBounds();
    saveModelBounds(this.boundsCacheUrl, this.modelFingerprint, {
      min: bounds.min.toArray(), max: bounds.max.toArray(),
    });
    return bounds;
  }

  calculateContentBounds() {
    if (!this.mixer || !this.animationClip) {
      return new THREE.Box3().setFromObject(this.modelRoot, true);
    }

    const bounds = new THREE.Box3().makeEmpty();
    const sampleCount = Math.max(
      24,
      Math.min(72, Math.ceil(this.animationClip.duration * 12)),
    );

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const sampleTime = (this.animationClip.duration * sampleIndex) / sampleCount;
      this.mixer.setTime(sampleTime);
      this.modelRoot.updateMatrixWorld(true);
      bounds.union(new THREE.Box3().setFromObject(this.modelRoot, true));
    }

    this.mixer.setTime(0);
    this.modelRoot.updateMatrixWorld(true);
    return bounds;
  }

  frameCameraToBox(box) {
    const center = box.getCenter(new THREE.Vector3());
    const distance = fitDistanceForBox(box, this.camera, INITIAL_VIEW_DIRECTION);
    const radius = Math.max(
      box.getBoundingSphere(new THREE.Sphere()).radius,
      0.01,
    );

    this.camera.position
      .copy(center)
      .addScaledVector(INITIAL_VIEW_DIRECTION, distance);
    this.camera.near = Math.max(distance / 100, 0.001);
    this.camera.far = distance + radius * 6;
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();

    this.orbitControls.target.copy(center);
    this.orbitControls.minDistance = Math.max(distance * 0.42, radius * 0.8);
    this.orbitControls.maxDistance = distance * 4.5;
    this.orbitControls.update();
  }

  createGround(box) {
    const boxSize = box.getSize(new THREE.Vector3());
    const groundSize = Math.max(boxSize.x, boxSize.z, 1) * 7;
    const groundMaterial = new THREE.ShadowMaterial({
      color: 0x7d8794,
      opacity: 0.13,
      transparent: true,
    });

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      groundMaterial,
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = box.min.y - Math.max(boxSize.y * 0.008, 0.012);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  buildTextureButton() {
    if (!this.hasTextureMaterial) {
      return;
    }

    const meshButton = this.controlsElement.querySelector('[data-mode="mesh"]');
    const button = document.createElement("button");
    button.className = "viewer-mode";
    button.type = "button";
    button.dataset.mode = "texture";
    button.textContent = "Tex";
    button.setAttribute("aria-pressed", "false");
    button.disabled = true;
    meshButton?.after(button);
  }

  buildBoneButtons() {
    const availableGroups = new Set(this.boneRecords.map((record) => record.group));
    const orderedGroups = [
      ...(availableGroups.has("body") ? ["body"] : []),
      ...BONE_KEYWORDS.filter((keyword) => availableGroups.has(keyword)),
    ];

    orderedGroups.forEach((group) => {
      const button = document.createElement("button");
      button.className = "viewer-mode";
      button.type = "button";
      button.dataset.mode = "skeleton";
      button.dataset.group = group;
      button.textContent = group === "body" ? "Body" : titleCase(group);
      button.setAttribute("aria-pressed", "false");
      this.boneButtonHost.append(button);
    });
  }

  enableControls() {
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      button.disabled = false;
    });

    this.updateActiveButtons();
  }

  setMode(nextMode, group = null) {
    if (
      (nextMode === "texture" && this.mode === "texture") ||
      (nextMode === "weights" && this.mode === "weights") ||
      (nextMode === "skeleton" && this.mode === "skeleton" && this.activeGroup === group)
    ) {
      nextMode = "mesh";
      group = null;
    }

    this.restoreMeshMaterials();
    this.clearSkeletonVisual();
    this.modelRoot.visible = true;

    if (nextMode === "weights") {
      this.applyWeightMaterials();
    } else if (nextMode === "texture") {
      this.applyTextureMaterials();
    } else if (nextMode === "skeleton") {
      this.modelRoot.updateMatrixWorld(true);
      this.createSkeletonVisual(group);
    }

    this.mode = nextMode;
    this.activeGroup = nextMode === "skeleton" ? group : null;
    this.updateActiveButtons();
  }

  applyWeightMaterials() {
    this.meshRecords.forEach((record) => {
      if (!record.mesh.isSkinnedMesh) return;
      if (!record.weightGeometry) {
        record.weightGeometry = this.createWeightGeometry(record.mesh, record.displayGeometry, record.boneColors);
        record.weightMaterial = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          metalness: 0,
          roughness: CLAY_ROUGHNESS,
          side: THREE.FrontSide,
          transparent: false,
          opacity: 1,
          depthWrite: true,
          vertexColors: true,
        });
      }

      record.mesh.geometry = record.weightGeometry;
      record.mesh.material = record.weightMaterial;
    });
  }

  applyTextureMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.displayGeometry;
      record.mesh.material = record.textureMaterial;
    });
  }

  restoreMeshMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.displayGeometry;
      record.mesh.material = record.displayMaterial;
    });
  }

  createSkeletonVisual(group) {
    const records = this.boneRecords.filter((record) => record.group === group);
    const visual = new THREE.Group();
    visual.name = `skeleton-${group}`;

    if (records.length === 0) {
      this.skeletonVisual = visual;
      this.scene.add(visual);
      return;
    }

    const makeMaterial = (color) => new THREE.MeshStandardMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.16),
      metalness: 0,
      roughness: 0.42,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const jointMaterial = makeMaterial(colorForGroup(group, "joint"));
    const boneMaterial = makeMaterial(colorForGroup(group, "bone"));
    const jointGeometry = new THREE.SphereGeometry(JOINT_RADIUS, 16, 12);
    const boneGeometry = new THREE.CylinderGeometry(
      BONE_RADIUS,
      BONE_RADIUS,
      1,
      12,
      1,
      false,
    );

    this.skeletonResources = { jointMaterial, boneMaterial, jointGeometry, boneGeometry };
    const visibleJointIds = new Set();
    const addJoint = (bone) => {
      if (visibleJointIds.has(bone.uuid)) {
        return;
      }

      visibleJointIds.add(bone.uuid);
      const joint = new THREE.Mesh(jointGeometry, jointMaterial);
      joint.renderOrder = 11;
      visual.add(joint);
      this.skeletonJoints.push({ bone, mesh: joint });
    };

    records.forEach(({ bone }) => {
      addJoint(bone);

      if (!bone.parent?.isBone) {
        return;
      }

      addJoint(bone.parent);
      const boneSegment = new THREE.Mesh(boneGeometry, boneMaterial);
      boneSegment.renderOrder = 10;
      visual.add(boneSegment);
      this.skeletonSegments.push({
        bone,
        parentBone: bone.parent,
        mesh: boneSegment,
      });
    });

    this.skeletonVisual = visual;
    this.scene.add(visual);
    this.updateSkeletonVisualPositions();
  }

  updateSkeletonVisualPositions() {
    this.skeletonJoints.forEach(({ bone, mesh }) => {
      mesh.position.copy(bone.getWorldPosition(new THREE.Vector3()));
    });

    this.skeletonSegments.forEach(({ bone, parentBone, mesh }) => {
      const jointPosition = bone.getWorldPosition(new THREE.Vector3());
      const parentPosition = parentBone.getWorldPosition(new THREE.Vector3());
      const direction = jointPosition.clone().sub(parentPosition);
      const length = direction.length();

      mesh.visible = length > Number.EPSILON;
      if (!mesh.visible) {
        return;
      }

      mesh.position.copy(parentPosition).add(jointPosition).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(
        CYLINDER_UP_AXIS,
        direction.normalize(),
      );
      mesh.scale.set(1, length, 1);
    });
  }

  clearSkeletonVisual() {
    if (!this.skeletonVisual) {
      return;
    }

    this.scene.remove(this.skeletonVisual);
    this.skeletonResources?.jointGeometry.dispose();
    this.skeletonResources?.boneGeometry.dispose();
    this.skeletonResources?.jointMaterial.dispose();
    this.skeletonResources?.boneMaterial.dispose();
    this.skeletonVisual = null;
    this.skeletonResources = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
  }

  updateActiveButtons() {
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      const isSkeletonButton = button.dataset.mode === "skeleton";
      const isActive = isSkeletonButton
        ? this.mode === "skeleton" && button.dataset.group === this.activeGroup
        : button.dataset.mode === this.mode;

      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }
}

const preloadObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.rigViewer?.setNearViewport(entry.isIntersecting);
      });
    },
    { rootMargin: "140px 160px" },
  )
  : null;

const visibilityObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
    entries.forEach((entry) => entry.target.rigViewer?.setVisible(entry.isIntersecting));
  }, { threshold: 0 })
  : null;

document.querySelectorAll(".rig-viewer").forEach((card) => {
  const viewer = new RigViewer(card);
  card.rigViewer = viewer;
  viewer.stage.rigViewer = viewer;
  viewers.push(viewer);

  if (preloadObserver) {
    preloadObserver.observe(viewer.stage);
    visibilityObserver.observe(viewer.stage);
  } else {
    viewer.setVisible(true);
  }
});

document.addEventListener("visibilitychange", () => {
  viewers.forEach((viewer) => viewer.updatePlayback());
  if (!document.hidden) processViewerLoadQueue();
});

document.addEventListener("animation-sample-change", () => {
  viewers.forEach((viewer) => {
    if (viewer.card.dataset.animation) {
      viewer.setEnabled(viewer.card.dataset.viewerEnabled !== "false");
      if (!preloadObserver) viewer.setVisible(viewer.isEnabled);
    }
  });
});
