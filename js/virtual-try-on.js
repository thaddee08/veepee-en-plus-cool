import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = () => document.getElementById("tryOnCanvas");
const statusNode = () => document.getElementById("tryOnStatus");
const listNode = () => document.getElementById("tryOnAssetStatus");
const ASSET_DATA = new URL("../data/try-on-assets.json", import.meta.url);
const FALLBACK_IMAGE = new URL("../assets/mannequin-photo.png", import.meta.url).href;
let runtime;
let manifestPromise;
let requestVersion = 0;

function status(message, kind = "info") {
  const node = statusNode();
  if (!node) return;
  node.textContent = message;
  node.dataset.kind = kind;
  node.hidden = false;
}

function showPhotoFallback(message) {
  const target = canvas()?.parentElement;
  if (!target) return;
  target.classList.add("try-on-fallback");
  let image = target.querySelector(".try-on-fallback-image");
  if (!image) {
    image = document.createElement("img");
    image.className = "try-on-fallback-image";
    image.alt = "The blank mannequin photo used as a static fallback";
    image.src = FALLBACK_IMAGE;
    target.append(image);
  }
  status(message, "error");
}

async function getManifest() {
  manifestPromise ||= fetch(ASSET_DATA, { cache: "no-cache" }).then(response => {
    if (!response.ok) throw new Error("Try-on asset manifest could not be loaded.");
    return response.json();
  });
  return manifestPromise;
}

function makeRenderer(target) {
  const renderer = new THREE.WebGLRenderer({
    canvas: canvas(),
    alpha: true,
    antialias: window.devicePixelRatio < 2,
    powerPreference: "high-performance"
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.setSize(target.clientWidth, target.clientHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  return renderer;
}

function createRuntime() {
  const target = document.querySelector(".try-on-canvas-wrap");
  const drawingSurface = canvas();
  if (!target || !drawingSurface) throw new Error("The 3D viewer is not available on this page.");
  let renderer;
  try { renderer = makeRenderer(target); }
  catch { throw new Error("This browser could not start WebGL. Try a recent browser with hardware acceleration enabled."); }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#e9e5de");
  const camera = new THREE.PerspectiveCamera(32, target.clientWidth / target.clientHeight, 0.05, 40);
  const focus = new THREE.Vector3(0, 0.91, 0);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(focus);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.enablePan = true;
  controls.minDistance = 1.7;
  controls.maxDistance = 6;
  controls.minPolarAngle = 0.48;
  controls.maxPolarAngle = Math.PI - 0.48;
  controls.update();

  scene.add(new THREE.HemisphereLight(0xfff8ee, 0x77716b, 2.15));
  const key = new THREE.DirectionalLight(0xfff5e8, 3.1);
  key.position.set(-2.5, 4.4, 3.2);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 9;
  key.shadow.bias = -0.0003;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xd9e3f1, 1.3);
  fill.position.set(2.5, 2.2, -2.5);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(12, 12),
    new THREE.ShadowMaterial({ color: 0x4a4037, opacity: 0.18 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  scene.add(floor);

  const modelRoot = new THREE.Group();
  const figure = new THREE.Group();
  const garmentRoot = new THREE.Group();
  modelRoot.add(figure, garmentRoot);
  scene.add(modelRoot);
  const loader = new GLTFLoader();
  const boneMap = new Map();
  let baseLoaded = false;
  let renderFrame = 0;
  let inView = true;

  const resize = () => {
    const width = target.clientWidth, height = target.clientHeight;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    renderer.render(scene, camera);
  };
  const renderLoop = () => {
    renderFrame = 0;
    if (!inView) return;
    controls.update();
    renderer.render(scene, camera);
    renderFrame = requestAnimationFrame(renderLoop);
  };
  const startRender = () => { if (!renderFrame && inView) renderFrame = requestAnimationFrame(renderLoop); };
  const observer = new IntersectionObserver(entries => {
    inView = entries.some(entry => entry.isIntersecting);
    if (inView) startRender();
    else if (renderFrame) { cancelAnimationFrame(renderFrame); renderFrame = 0; }
  }, { threshold: 0.01 });
  observer.observe(target);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(target);
  const destroy = () => {
    observer.disconnect(); resizeObserver.disconnect(); controls.dispose();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    disposeObject(garmentRoot); disposeObject(figure);
    floor.geometry.dispose(); floor.material.dispose(); renderer.dispose();
  };

  const lookAt = (azimuth, distance = camera.position.distanceTo(controls.target)) => {
    const polar = camera.position.distanceTo(controls.target);
    const elevation = Math.max(0.1, camera.position.y - controls.target.y);
    const radius = distance || polar || 3.5;
    camera.position.set(Math.sin(azimuth) * radius, controls.target.y + Math.min(0.55, elevation), Math.cos(azimuth) * radius);
    controls.target.copy(focus);
    controls.update();
  };

  document.querySelector(".try-on-toolbar")?.querySelectorAll("[data-tryon-view]").forEach(button => {
    button.addEventListener("click", () => {
      const view = button.dataset.tryonView;
      if (view === "front") lookAt(0);
      else if (view === "right") lookAt(Math.PI / 2);
      else if (view === "back") lookAt(Math.PI);
      else if (view === "left") lookAt(-Math.PI / 2);
      else if (view === "reset") {
        controls.target.copy(focus);
        camera.position.set(0, 1.12, 3.5);
        controls.update();
      } else if (view === "zoom-in" || view === "zoom-out") {
        const offset = camera.position.clone().sub(controls.target);
        offset.multiplyScalar(view === "zoom-in" ? 0.84 : 1.19);
        const distance = THREE.MathUtils.clamp(offset.length(), controls.minDistance, controls.maxDistance);
        offset.setLength(distance);
        camera.position.copy(controls.target).add(offset);
        controls.update();
      } else if (view === "clear") {
        window.dispatchEvent(new CustomEvent("restpost:clear-try-on"));
      }
    });
  });

  camera.position.set(0, 1.12, 3.5);
  controls.update();
  startRender();
  return { target, scene, camera, controls, renderer, loader, figure, garmentRoot, modelRoot, boneMap, get baseLoaded(){ return baseLoaded; }, set baseLoaded(value){ baseLoaded=value; }, lookAt, render:resize, destroy };
}

async function loadBase(app) {
  if (app.baseLoaded) return;
  const manifest = await getManifest();
  status("Loading the 3D mannequin… 0%", "loading");
  const url = new URL("../" + manifest.mannequin.modelUrl, import.meta.url);
  const gltf = await app.loader.loadAsync(url.href, event => {
    if (event.total) status("Loading the 3D mannequin… " + Math.round(event.loaded / event.total * 100) + "%", "loading");
  });
  const model = gltf.scene;
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  if (!Number.isFinite(size.y) || size.y <= 0) throw new Error("The mannequin model has no usable body mesh.");
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = Number(manifest.mannequin.heightMeters || 1.72) / size.y;
  app.modelRoot.scale.setScalar(scale);
  app.modelRoot.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
  model.traverse(object => {
    if (object.isSkinnedMesh) {
      object.castShadow = true; object.receiveShadow = true;
      for (const bone of object.skeleton.bones) app.boneMap.set(bone.name, bone);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      const displayMaterials = materials.map(material => new THREE.MeshPhysicalMaterial({
        color: "#eee9e2",
        roughness: 0.34,
        metalness: 0.015,
        clearcoat: 0.28,
        clearcoatRoughness: 0.24,
        map: material?.map || null,
        normalMap: material?.normalMap || null,
        roughnessMap: material?.roughnessMap || null
      }));
      object.material = Array.isArray(object.material) ? displayMaterials : displayMaterials[0];
    }
  });
  app.figure.add(model);
  app.baseLoaded = true;
  app.render();
}

function disposeObject(root) {
  while (root.children.length) {
    const object = root.children[0];
    root.remove(object);
    object.traverse(child => {
      child.geometry?.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => {
        if (!material) return;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose();
      });
    });
  }
}

function compatibleSkinnedAsset(gltf, app, config) {
  const sourceMeshes = [];
  gltf.scene.traverse(object => { if (object.isSkinnedMesh) sourceMeshes.push(object); });
  if (!sourceMeshes.length) throw new Error("This garment file has no rigged garment mesh.");
  if (config.rigId !== "restpost-human-base-v1") throw new Error("This garment was not fitted to the current mannequin rig.");
  for (const mesh of sourceMeshes) {
    const mapped = mesh.skeleton.bones.map(bone => app.boneMap.get(bone.name));
    if (mapped.some(bone => !bone)) throw new Error("The garment skeleton does not match this mannequin.");
    mesh.bind(new THREE.Skeleton(mapped, mesh.skeleton.boneInverses), mesh.bindMatrix);
    mesh.castShadow = true; mesh.receiveShadow = true;
  }
  return gltf.scene;
}

function renderItemStatus(items, configs, errors, loaded) {
  const box = listNode();
  if (!box) return;
  box.replaceChildren();
  const heading = document.createElement("span");
  const fitted = loaded.size;
  heading.className = "try-on-count";
  heading.textContent = fitted + " of " + items.length + " pieces have a fitted 3D model";
  box.append(heading);
  for (const item of items) {
    const row = document.createElement("div"); row.className = "try-on-asset-row";
    const name = document.createElement("span"); name.textContent = item.brand + " · " + item.name;
    const state = document.createElement("small");
    state.textContent = errors.has(item.url) ? "Model unavailable" : loaded.has(item.url) ? "3D fit loaded" : "3D garment asset needed";
    state.dataset.state = errors.has(item.url) ? "error" : loaded.has(item.url) ? "ready" : "missing";
    row.append(name, state); box.append(row);
  }
  if (!fitted) {
    const note = document.createElement("p");
    note.className = "try-on-honesty";
    note.textContent = "This sale feed has shop photos, not garment 3D models. The mannequin is real 3D; clothing appears here only when a fitted, licensed garment model is added.";
    box.append(note);
  }
}

export async function updateOutfit(items = []) {
  const version = ++requestVersion;
  try {
    if (runtime && runtime.renderer.domElement !== canvas()) { runtime.destroy(); runtime = null; }
    if (!runtime) runtime = createRuntime();
    const app = runtime;
    const manifest = await getManifest();
    await loadBase(app);
    if (version !== requestVersion) return;
    disposeObject(app.garmentRoot);
    const products = Array.isArray(manifest.products) ? manifest.products : [];
    const configs = new Map(products.map(item => [item.url, item]));
    const errors = new Map(), loaded = new Set();
    status("3D mannequin ready", "ready");
    for (const item of items) {
      const config = configs.get(item.url);
      if (!config?.modelUrl) continue;
      try {
        const url = new URL("../" + config.modelUrl, import.meta.url);
        const gltf = await app.loader.loadAsync(url.href);
        if (version !== requestVersion) return;
        const garment = compatibleSkinnedAsset(gltf, app, config);
        const offset = config.position || [0, 0, 0];
        const rotation = config.rotation || [0, 0, 0];
        garment.position.set(...offset);
        garment.rotation.set(...rotation);
        garment.scale.setScalar(Number(config.scale || 1));
        garment.renderOrder = Number(config.layerOrder || 1);
        app.garmentRoot.add(garment);
        loaded.add(item.url);
      } catch (error) { errors.set(item.url, error); }
    }
    app.render();
    renderItemStatus(items, configs, errors, loaded);
    status(loaded.size ? "3D mannequin dressed · " + loaded.size + " fitted " + (loaded.size === 1 ? "piece" : "pieces") : "3D mannequin ready · fitted garment models are not yet in this catalog", loaded.size ? "ready" : "missing");
  } catch (error) {
    showPhotoFallback(error.message || "The 3D fitting room could not load.");
    const box = listNode();
    if (box) box.textContent = "The 3D fitting room is unavailable. Product photos and store links are still available beside this preview.";
  }
}

window.addEventListener("resize", () => runtime?.render());
window.addEventListener("pagehide", () => runtime?.destroy(), { once: true });
