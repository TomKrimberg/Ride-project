// game.js — Three.js scene, world generation, day/night cycle, render loop,
// minimap, skid VFX and the delivery/free-drive game modes.
//
// game.js never imports physics.js, ui.js or audio.js directly. Those are
// created in main.js and handed to createGame(...) as arguments
// (dependency injection). This keeps the module graph a simple DAG with no
// circular imports, which matters because several of these modules need to
// call back into each other at runtime.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export const ASSET_BASE = 'https://tomkrimberg.github.io/Ride-project/assets/';

export const CAR_CATALOG = {
  suzuki:      { name: 'Suzuki Swift',  price: 0,    baseTopSpeed: 30, accel: 20, turnRate: 2.6, grip: 0.90, driftGrip: 0.50, mass: 120, model: 'car_suzuki.glb',      color: 0xe8eaf0 },
  porsche:     { name: 'Porsche',       price: 350,  baseTopSpeed: 42, accel: 25, turnRate: 2.25, grip: 0.92, driftGrip: 0.55, mass: 150, model: 'car_porsche.glb',     color: 0xc41e2a },
  lamborghini: { name: 'Lamborghini',   price: 900,  baseTopSpeed: 52, accel: 30, turnRate: 2.05, grip: 0.94, driftGrip: 0.60, mass: 160, model: 'car_lamborghini.glb', color: 0xf6c90e },
  mclaren:     { name: 'McLaren',       price: 1500, baseTopSpeed: 62, accel: 34, turnRate: 1.9,  grip: 0.95, driftGrip: 0.62, mass: 165, model: 'car_mclaren.glb',     color: 0xff7a00 }
};
export const CAR_ORDER = ['suzuki', 'porsche', 'lamborghini', 'mclaren'];
export const REPAIR_COST = 25;
export const MAX_UPGRADE_LEVEL = 3;
export const UPGRADE_BASE_COST = 60;
export const UPGRADE_SPEED_BONUS = 0.09; // +9% top speed per level
export const STAR_REWARDS = [0, 10, 20, 30, 40, 50]; // index = star count

const GRID_SIZE = 6;
const BLOCK = 52;
const ROAD_WIDTH = 14;
const BUILDING_FOOT = BLOCK - ROAD_WIDTH;
const MAP_HALF = (GRID_SIZE * BLOCK) / 2;

export function createGame(AppState, InputState, physics, ui, audio, persist) {
  const canvas = document.getElementById('game-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const fogColorDay = new THREE.Color(0x8fb7d9);
  const fogColorNight = new THREE.Color(0x03040a);
  scene.fog = new THREE.Fog(fogColorDay.clone(), 60, 220);
  scene.background = fogColorDay.clone();

  const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 500);
  const minimapCamera = new THREE.OrthographicCamera(-45, 45, 45, -45, 1, 300);
  minimapCamera.position.set(0, 120, 0);
  minimapCamera.up.set(0, 0, -1);
  minimapCamera.lookAt(0, 0, 0);

  // --- Lighting -----------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xbcd4ff, 0x2b2f24, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 200;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);
  const ambient = new THREE.AmbientLight(0x223047, 0.15);
  scene.add(ambient);

  // --- Post-processing (kept minimal for mobile GPUs) ----------------------
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.5, 0.4, 0.85);
  bloomPass.enabled = true;
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    bloomPass.setSize ? bloomPass.setSize(w, h) : null;
  }
  window.addEventListener('resize', resize);

  // --- Asset loading with graceful fallbacks -------------------------------
  const loader = new GLTFLoader();
  const modelCache = new Map();

  function loadModel(filename) {
    if (modelCache.has(filename)) return modelCache.get(filename);
    const promise = new Promise((resolve) => {
      loader.load(
        ASSET_BASE + filename,
        (gltf) => resolve(gltf),
        undefined,
        () => {
          console.warn(`[RIDE] Could not load ${filename}, using a fallback primitive instead.`);
          resolve(null);
        }
      );
    });
    modelCache.set(filename, promise);
    return promise;
  }

  function cloneGltf(gltf) {
    const clone = SkeletonUtils.clone(gltf.scene);
    return { scene: clone, animations: gltf.animations };
  }

  // Many "kit"/"pack" assets (trees_and_bush_pack.glb, city_buildings.glb,
  // traffic_signs.glb) bundle several unrelated variants together as
  // sibling nodes in one file, rather than being a single model. Cloning
  // gltf.scene wholesale for every placement would stamp the *entire*
  // bundle down at every spot in the city — which is exactly the
  // "buildings splashing everywhere" bug. This picks ONE variant instead,
  // and re-centers it so it drops in cleanly regardless of where it sat
  // inside the original kit's layout.
  //
  // Do NOT use this for single coherent models (cars, characters, the
  // traffic light) — picking one child out of those would tear apart a
  // model that's supposed to stay whole (e.g. a car body without its
  // wheels, or a lamp post without its lamp).
  function extractRandomVariant(gltf) {
    // Exporters commonly wrap an entire kit in one root "Scene" group, so
    // the real list of interchangeable variants is often one level (or
    // more) below gltf.scene itself. Walk down through single-child
    // wrapper nodes until we hit an actual branching point, and treat
    // that point's children as the variant list. If nothing branches,
    // this is a normal single-object file — fall back to cloning it whole.
    let node = gltf.scene;
    while (node.children && node.children.length === 1 && !node.isMesh && !node.isSkinnedMesh) {
      node = node.children[0];
    }
    const candidates = (node.children && node.children.length > 1) ? node.children : [gltf.scene];
    const source = candidates[Math.floor(Math.random() * candidates.length)];
    const cloned = SkeletonUtils.clone(source);
    const box = new THREE.Box3().setFromObject(cloned);
    if (isFinite(box.min.x)) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      cloned.position.x -= center.x;
      cloned.position.z -= center.z;
      cloned.position.y -= box.min.y;
    }
    return cloned;
  }

  function enableShadows(object) {
    object.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
  }

  // --- Fallback primitive builders (used if a .glb fails to load) ---------
  function fallbackCar(color) {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.5, roughness: 0.35 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.2, roughness: 0.1 });
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 3.8), bodyMat);
    chassis.position.y = 0.35;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 1.8), glassMat);
    cabin.position.set(0, 0.85, -0.2);
    group.add(chassis, cabin);
    const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.3, 12);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.8 });
    const wheelPositions = [[-0.95, 0.1, 1.3], [0.95, 0.1, 1.3], [-0.95, 0.1, -1.3], [0.95, 0.1, -1.3]];
    for (const [x, y, z] of wheelPositions) {
      const wheel = new THREE.Mesh(wheelGeo, wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(x, y, z);
      group.add(wheel);
    }
    enableShadows(group);
    return group;
  }

  function fallbackHumanoid(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.9, 4, 8), mat);
    body.position.y = 0.95;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), new THREE.MeshStandardMaterial({ color: 0xffe0bd }));
    head.position.y = 1.65;
    group.add(body, head);
    enableShadows(group);
    return group;
  }

  function fallbackQuadruped(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 4, 8), mat);
    body.rotation.z = Math.PI / 2;
    body.position.y = 0.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), mat);
    head.position.set(0.35, 0.36, 0);
    group.add(body, head);
    enableShadows(group);
    return group;
  }

  function fallbackRobot(color) {
    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.4 });
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x66e0ff, emissive: 0x2ad4ff, emissiveIntensity: 1 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.4), mat);
    body.position.y = 0.55;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.28, 0.3), mat);
    head.position.y = 1.05;
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.05), eyeMat);
    eye.position.set(0, 1.05, 0.16);
    group.add(body, head, eye);
    enableShadows(group);
    return group;
  }

  function buildingWindowTexture(seed) {
    const size = 128;
    const cvs = document.createElement('canvas');
    cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#1c2333';
    ctx.fillRect(0, 0, size, size);
    const rows = 8, cols = 6;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = Math.sin(seed + r * 12.9898 + c * 78.233) * 43758.5453 % 1 > 0.45;
        ctx.fillStyle = lit ? '#ffd98a' : '#0d1220';
        const w = size / cols, h = size / rows;
        ctx.fillRect(c * w + 2, r * h + 2, w - 4, h - 4);
      }
    }
    const tex = new THREE.CanvasTexture(cvs);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  function laneMarkingTexture() {
    const cvs = document.createElement('canvas');
    cvs.width = 64; cvs.height = 64;
    const ctx = cvs.getContext('2d');
    ctx.fillStyle = '#2b2e33';
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = '#3a3d43';
    for (let i = 0; i < 64; i += 8) ctx.fillRect(0, i, 64, 1);
    const tex = new THREE.CanvasTexture(cvs);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(GRID_SIZE * 6, GRID_SIZE * 6);
    return tex;
  }

  // --- World state ----------------------------------------------------------
  const npcMeshes = []; // { entity(from physics), mesh, mixer }
  const streetLights = [];
  const deliveryWaypoints = [];
  const skidMarks = []; // { mesh, life }
  const coinPickups = [];
  let carGroup = null;
  let carLightsNight = [];
  let missionMarker = null; // glowing beacon shown at the active pickup/dropoff point
  let carriedPackageMesh = null; // small box shown on the car roof while carrying a delivery
  let coinGltf = null;
  let packageGltf = null;
  let currentMode = 'menu'; // 'menu' | 'freedrive' | 'delivery'
  let mission = null; // { pickup, dropoff, timeLimit, timeLeft, phase }
  let dayTime = 0.28; // 0..1, start mid-morning
  const DAY_LENGTH_SECONDS = 260;
  let paused = false;
  let running = false;
  const clock = new THREE.Clock();
  let menuCamAngle = 0;

  async function buildCity() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(GRID_SIZE * BLOCK + 40, GRID_SIZE * BLOCK + 40),
      new THREE.MeshStandardMaterial({ map: laneMarkingTexture(), roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
    // Note: the static ground collision plane itself is created inside
    // physics.js (createPhysicsWorld), so it exists before this runs.

    const [buildingsGltf, treesGltf, signGltf, lightGltf, roadsGltf, loadedCoinGltf, loadedPackageGltf] = await Promise.all([
      loadModel('city_buildings.glb'),
      loadModel('trees_and_bush_pack.glb'),
      loadModel('traffic_signs.glb'),
      loadModel('traffic_light.glb'),
      loadModel('roads.glb'),
      loadModel('coin.glb'),
      loadModel('amazon_boxes.glb')
    ]);
    coinGltf = loadedCoinGltf;
    packageGltf = loadedPackageGltf;
    buildMissionMarker();

    if (roadsGltf) {
      // roads.glb is decorative on top of the procedural ground plane below
      // (which still owns the physics collision + guaranteed lane texture),
      // so a missing/odd road asset never breaks driving or collision.
      for (let bx = 0; bx < GRID_SIZE - 1; bx++) {
        for (let bz = 0; bz < GRID_SIZE - 1; bz++) {
          const cx = (bx - (GRID_SIZE - 1) / 2) * BLOCK + BLOCK / 2;
          const cz = (bz - (GRID_SIZE - 1) / 2) * BLOCK + BLOCK / 2;
          const tile = extractRandomVariant(roadsGltf);
          const box = new THREE.Box3().setFromObject(tile);
          const size = new THREE.Vector3();
          box.getSize(size);
          const scale = BLOCK / Math.max(size.x, size.z, 1);
          tile.scale.setScalar(scale);
          tile.position.set(cx, 0.02, cz);
          tile.receiveShadow = true;
          scene.add(tile);
        }
      }
    }

    let waypointId = 0;
    for (let bx = 0; bx < GRID_SIZE; bx++) {
      for (let bz = 0; bz < GRID_SIZE; bz++) {
        const cx = (bx - (GRID_SIZE - 1) / 2) * BLOCK;
        const cz = (bz - (GRID_SIZE - 1) / 2) * BLOCK;

        // Leave a few open blocks as plazas so the map doesn't feel like a solid maze
        const isPlaza = (bx + bz) % 7 === 0;

        if (!isPlaza) {
          let buildingMesh;
          if (buildingsGltf) {
            // Unlike trees_and_bush_pack.glb / traffic_signs.glb (which are
            // genuine multi-variant kits), city_buildings.glb behaves like a
            // single composed building made of several parts (walls, a
            // column, a roof) rather than several alternative buildings —
            // extracting "one child" from it was grabbing an isolated part
            // (e.g. just a support column) instead of the whole structure.
            // Clone it whole here instead.
            buildingMesh = cloneGltf(buildingsGltf).scene;
            const box = new THREE.Box3().setFromObject(buildingMesh);
            const sizeVec = new THREE.Vector3();
            box.getSize(sizeVec);
            const scale = BUILDING_FOOT / Math.max(sizeVec.x, sizeVec.z, 1);
            buildingMesh.scale.setScalar(scale * (0.7 + Math.random() * 0.5));
          } else {
            const height = 8 + Math.random() * 26;
            const mat = new THREE.MeshStandardMaterial({
              map: buildingWindowTexture(bx * 13.1 + bz * 7.7),
              roughness: 0.8
            });
            buildingMesh = new THREE.Mesh(new THREE.BoxGeometry(BUILDING_FOOT * 0.8, height, BUILDING_FOOT * 0.8), mat);
            buildingMesh.position.y = height / 2;
          }
          buildingMesh.position.x += cx;
          buildingMesh.position.z += cz;
          buildingMesh.rotation.y = Math.round(Math.random() * 4) * (Math.PI / 2);
          enableShadows(buildingMesh);
          scene.add(buildingMesh);

          const box = new THREE.Box3().setFromObject(buildingMesh);
          const size = new THREE.Vector3();
          box.getSize(size);
          physics.addProp({ x: cx, y: size.y / 2, z: cz }, { x: size.x / 2, y: size.y / 2, z: size.z / 2 }, 0);

          // Sidewalk skirt
          const sidewalk = new THREE.Mesh(
            new THREE.BoxGeometry(BUILDING_FOOT + 4, 0.15, BUILDING_FOOT + 4),
            new THREE.MeshStandardMaterial({ color: 0x8d8f94, roughness: 1 })
          );
          sidewalk.position.set(cx, 0.08, cz);
          sidewalk.receiveShadow = true;
          scene.add(sidewalk);

          // A couple of trees per block corner
          for (let t = 0; t < 2; t++) {
            const angle = Math.random() * Math.PI * 2;
            const r = BUILDING_FOOT / 2 + 3 + Math.random() * 2;
            const tx = cx + Math.cos(angle) * r;
            const tz = cz + Math.sin(angle) * r;
            let tree;
            if (treesGltf) {
              tree = extractRandomVariant(treesGltf);
              tree.scale.setScalar(0.8 + Math.random() * 0.6);
            } else {
              tree = new THREE.Group();
              const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 2.2, 6), new THREE.MeshStandardMaterial({ color: 0x5b4433 }));
              trunk.position.y = 1.1;
              const leaves = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 8), new THREE.MeshStandardMaterial({ color: 0x2f6b3a }));
              leaves.position.y = 2.6;
              tree.add(trunk, leaves);
            }
            tree.position.set(tx, 0, tz);
            enableShadows(tree);
            scene.add(tree);
          }

          if (waypointId < 40 && Math.random() > 0.4) {
            deliveryWaypoints.push({
              id: `wp${waypointId++}`,
              position: new THREE.Vector3(cx + BUILDING_FOOT / 2 + 5, 0, cz)
            });
          }

          // Sidewalk patrol loop for NPCs on this block
          if (Math.random() > 0.45) {
            const r2 = BUILDING_FOOT / 2 + 3.5;
            const loop = [
              { x: cx - r2, z: cz - r2 }, { x: cx + r2, z: cz - r2 },
              { x: cx + r2, z: cz + r2 }, { x: cx - r2, z: cz + r2 }
            ];
            spawnNPC(loop);
          }
        }

        // Intersection streetlight
        if (bx < GRID_SIZE - 1 && bz < GRID_SIZE - 1) {
          const lightPost = buildStreetLight(lightGltf);
          lightPost.position.set(cx + BLOCK / 2, 0, cz + BLOCK / 2);
          scene.add(lightPost);
        }
        // Occasional traffic sign along the road
        if (signGltf && Math.random() > 0.7) {
          const sign = extractRandomVariant(signGltf);
          sign.position.set(cx + BUILDING_FOOT / 2 + 1.5, 0, cz - BUILDING_FOOT / 2 - 1.5);
          enableShadows(sign);
          scene.add(sign);
        }
      }
    }

    // Guarantee enough delivery waypoints exist even if the random block
    // rolls above were unlucky, so mission generation never stalls.
    if (deliveryWaypoints.length < 6) {
      const corners = [
        [MAP_HALF - 6, MAP_HALF - 6], [-(MAP_HALF - 6), MAP_HALF - 6],
        [MAP_HALF - 6, -(MAP_HALF - 6)], [-(MAP_HALF - 6), -(MAP_HALF - 6)],
        [0, MAP_HALF - 6], [0, -(MAP_HALF - 6)]
      ];
      corners.forEach(([x, z], i) => deliveryWaypoints.push({ id: `fallback${i}`, position: new THREE.Vector3(x, 0, z) }));
    }

    // Coin pickups scattered on roads, refreshed periodically in Free Drive
    for (let i = 0; i < 24; i++) spawnCoin();
  }

  function buildStreetLight(lightGltf) {
    const group = new THREE.Group();
    if (lightGltf) {
      const model = cloneGltf(lightGltf).scene;
      group.add(model);
    } else {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 5, 6), new THREE.MeshStandardMaterial({ color: 0x2b2e33 }));
      pole.position.y = 2.5;
      const lampGeo = new THREE.SphereGeometry(0.22, 8, 8);
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xfff3c4, emissiveIntensity: 0 });
      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.y = 5;
      group.add(pole, lamp);
      group.userData.lampMat = lampMat;
    }
    const light = new THREE.PointLight(0xffdf9e, 0, 10, 2);
    light.position.y = 5;
    light.castShadow = false;
    group.add(light);
    group.userData.light = light;
    streetLights.push(group);
    return group;
  }

  function spawnCoin() {
    const pos = randomRoadPoint();
    let mesh;
    if (coinGltf) {
      mesh = extractRandomVariant(coinGltf);
      const box = new THREE.Box3().setFromObject(mesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = 0.7 / Math.max(size.x, size.y, size.z, 0.01);
      mesh.scale.setScalar(scale);
      enableShadows(mesh);
    } else {
      const geo = new THREE.TorusGeometry(0.35, 0.14, 8, 16);
      const mat = new THREE.MeshStandardMaterial({ color: 0xffc145, emissive: 0xffa000, emissiveIntensity: 0.4, metalness: 0.7, roughness: 0.3 });
      mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = Math.PI / 2;
    }
    mesh.position.set(pos.x, 0.6, pos.z);
    scene.add(mesh);
    coinPickups.push({ mesh, position: pos, spin: Math.random() * Math.PI });
  }

  function randomRoadPoint() {
    const bx = Math.floor(Math.random() * GRID_SIZE) - GRID_SIZE / 2;
    const bz = Math.floor(Math.random() * GRID_SIZE) - GRID_SIZE / 2;
    const alongRoad = (Math.random() - 0.5) * BLOCK;
    return Math.random() > 0.5
      ? new THREE.Vector3(bx * BLOCK + BLOCK / 2, 0, bz * BLOCK + alongRoad)
      : new THREE.Vector3(bx * BLOCK + alongRoad, 0, bz * BLOCK + BLOCK / 2);
  }

  const NPC_TYPES = [
    { model: 'young_woman.glb', kind: 'human', color: 0xdd6b8a },
    { model: 'character_fatman.glb', kind: 'human', color: 0x5c8ad1 },
    { model: 'dog.glb', kind: 'animal', color: 0xa9702f },
    { model: 'cat_bicolor.glb', kind: 'animal', color: 0x333333 },
    { model: 'ubers_delivery_robot.glb', kind: 'robot', color: 0x9aa5b1 }
  ];

  async function spawnNPC(loopPoints) {
    const type = NPC_TYPES[Math.floor(Math.random() * NPC_TYPES.length)];
    const gltf = await loadModel(type.model);
    let mesh, mixer = null;
    if (gltf) {
      const cloned = cloneGltf(gltf);
      mesh = cloned.scene;
      if (cloned.animations && cloned.animations.length) {
        mixer = new THREE.AnimationMixer(mesh);
        const clip = cloned.animations.find((a) => /walk|run/i.test(a.name)) || cloned.animations[0];
        mixer.clipAction(clip).play();
      }
    } else if (type.kind === 'human') {
      mesh = fallbackHumanoid(type.color);
    } else if (type.kind === 'robot') {
      mesh = fallbackRobot(type.color);
    } else {
      mesh = fallbackQuadruped(type.color);
    }
    enableShadows(mesh);
    scene.add(mesh);
    const start = loopPoints[0];
    const walkSpeed = type.kind === 'animal' ? 1.6 + Math.random() * 0.8
      : type.kind === 'robot' ? 0.9 + Math.random() * 0.3
      : 1.1 + Math.random() * 0.6;
    const entity = physics.addNPC(start, loopPoints, walkSpeed);
    npcMeshes.push({ entity, mesh, mixer });
  }

  // --- Player car -------------------------------------------------------
  async function setActiveCar(carId) {
    const stats = getEffectiveStats(carId);
    if (carGroup) scene.remove(carGroup);
    carLightsNight = [];

    const def = CAR_CATALOG[carId];
    const gltf = await loadModel(def.model);
    // carGroup itself is an EMPTY anchor group — this is what gets synced to
    // the physics body's position/rotation every frame, and what the chase
    // camera offsets from. The actual model goes inside it, re-centered.
    // Downloaded car models very often have an off-center pivot (at a wheel,
    // a corner, wherever the artist happened to export from); syncing that
    // raw pivot straight to the physics body — as earlier code did — throws
    // the camera and headlights off by however far the pivot is from the
    // car's real center, which is exactly what caused the camera to end up
    // clipped inside a wheel.
    carGroup = new THREE.Group();
    let visualModel;
    if (gltf) {
      visualModel = cloneGltf(gltf).scene;
      const rawBox = new THREE.Box3().setFromObject(visualModel);
      const rawSize = new THREE.Vector3();
      rawBox.getSize(rawSize);
      const scale = 3.6 / Math.max(rawSize.z, 0.1);
      visualModel.scale.setScalar(scale);
      const scaledBox = new THREE.Box3().setFromObject(visualModel);
      if (isFinite(scaledBox.min.x)) {
        const center = new THREE.Vector3();
        scaledBox.getCenter(center);
        visualModel.position.sub(center);
      }
    } else {
      visualModel = fallbackCar(def.color);
    }
    enableShadows(visualModel);
    carGroup.add(visualModel);
    scene.add(carGroup);

    const headlightL = new THREE.SpotLight(0xffffff, 0, 26, Math.PI / 7, 0.4, 1.4);
    const headlightR = headlightL.clone();
    headlightL.position.set(-0.55, 0.6, 1.8);
    headlightR.position.set(0.55, 0.6, 1.8);
    const target = new THREE.Object3D();
    target.position.set(0, 0, 12);
    carGroup.add(target);
    headlightL.target = target;
    headlightR.target = target;
    carGroup.add(headlightL, headlightR);
    carLightsNight.push(headlightL, headlightR);

    physics.createCarBody(stats, { x: 0, y: 1.2, z: 15 });
    return carGroup;
  }

  function getEffectiveStats(carId) {
    const def = CAR_CATALOG[carId];
    const level = AppState.upgrades[carId] || 0;
    const bonus = 1 + level * UPGRADE_SPEED_BONUS;
    return {
      mass: def.mass,
      accel: def.accel,
      turnRate: def.turnRate,
      grip: def.grip,
      driftGrip: def.driftGrip,
      topSpeed: def.baseTopSpeed * bonus
    };
  }

  // --- Skid marks ---------------------------------------------------------
  const skidMat = new THREE.MeshBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.5, depthWrite: false });
  function spawnSkidMark(position, rotationY) {
    const geo = new THREE.PlaneGeometry(0.28, 0.9);
    const mesh = new THREE.Mesh(geo, skidMat.clone());
    mesh.rotation.x = -Math.PI / 2;
    mesh.rotation.z = rotationY;
    mesh.position.set(position.x, 0.03, position.z);
    scene.add(mesh);
    skidMarks.push({ mesh, life: 6 });
    if (skidMarks.length > 240) {
      const old = skidMarks.shift();
      scene.remove(old.mesh);
      old.mesh.geometry.dispose();
      old.mesh.material.dispose();
    }
  }

  function updateSkidMarks(dt) {
    for (let i = skidMarks.length - 1; i >= 0; i--) {
      const s = skidMarks[i];
      s.life -= dt;
      s.mesh.material.opacity = Math.max(0, Math.min(0.5, s.life / 2));
      if (s.life <= 0) {
        scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        s.mesh.material.dispose();
        skidMarks.splice(i, 1);
      }
    }
  }

  // --- Day / night cycle ----------------------------------------------------
  // The main menu always shows a fixed golden-hour look (per the brief: "a
  // clean, cinematic scene at sunset"), independent of whatever time it is
  // in the live day/night cycle used during gameplay.
  function applyMenuSunset() {
    sun.position.set(70, 14, -30);
    sun.target.position.set(0, 0, 0);
    sun.intensity = 1.1;
    sun.color.set(0xffb173);
    hemi.intensity = 0.55;
    ambient.intensity = 0.12;
    const sunset = new THREE.Color(0xff9d5c).lerp(new THREE.Color(0x1c2540), 0.55);
    scene.fog.color.copy(sunset);
    scene.background = sunset;
    bloomPass.strength = 0.55;
    for (const light of carLightsNight) light.intensity = 2.2;
    for (const post of streetLights) {
      post.userData.light.intensity = 0;
      if (post.userData.lampMat) post.userData.lampMat.emissiveIntensity = 0;
    }
  }

  function updateDayNight(dt) {
    dayTime = (dayTime + dt / DAY_LENGTH_SECONDS) % 1;
    const angle = dayTime * Math.PI * 2;
    const sunHeight = Math.sin(angle);
    sun.position.set(Math.cos(angle) * 100, Math.max(sunHeight, -0.15) * 100 + 20, 40);
    sun.target.position.set(0, 0, 0);

    const dayFactor = THREE.MathUtils.clamp(sunHeight * 1.6 + 0.25, 0, 1); // 1 = full day, 0 = full night
    sun.color.copy(new THREE.Color(0x8fb3ff).lerp(new THREE.Color(0xfff2d6), dayFactor));
    sun.intensity = 0.15 + dayFactor * 1.5;
    hemi.intensity = 0.25 + dayFactor * 0.75;
    ambient.intensity = 0.08 + (1 - dayFactor) * 0.18;

    const skyColor = fogColorNight.clone().lerp(fogColorDay, dayFactor);
    scene.fog.color.copy(skyColor);
    scene.background = skyColor;

    const nightFactor = 1 - dayFactor;
    for (const light of carLightsNight) light.intensity = nightFactor > 0.55 ? 3.5 : 0;
    for (const post of streetLights) {
      post.userData.light.intensity = nightFactor > 0.5 ? 1.6 : 0;
      if (post.userData.lampMat) post.userData.lampMat.emissiveIntensity = nightFactor > 0.5 ? 1.4 : 0;
    }
    bloomPass.strength = 0.35 + nightFactor * 0.55;
  }

  // --- Camera follow --------------------------------------------------------
  const camOffset = new THREE.Vector3(0, 4.2, -8.5);
  const camLookOffset = new THREE.Vector3(0, 1.2, 4);
  function updateChaseCamera(dt) {
    if (!carGroup) return;
    const desired = camOffset.clone().applyQuaternion(carGroup.quaternion).add(carGroup.position);
    camera.position.lerp(desired, 1 - Math.pow(0.001, dt));
    const lookAt = camLookOffset.clone().applyQuaternion(carGroup.quaternion).add(carGroup.position);
    camera.lookAt(lookAt);
  }

  function updateMenuCamera(dt) {
    if (!carGroup) return;
    menuCamAngle += dt * 0.35;
    const r = 6;
    camera.position.set(Math.sin(menuCamAngle) * r, 2.2, Math.cos(menuCamAngle) * r);
    camera.lookAt(carGroup.position.x, 1, carGroup.position.z);
    carGroup.rotation.y += dt * 0.5;
  }

  // --- Missions ---------------------------------------------------------
  function pickTwoDistinctWaypoints() {
    const a = deliveryWaypoints[Math.floor(Math.random() * deliveryWaypoints.length)];
    let b = a;
    while (b === a) b = deliveryWaypoints[Math.floor(Math.random() * deliveryWaypoints.length)];
    return [a, b];
  }

  function buildMissionMarker() {
    missionMarker = new THREE.Group();
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffc145, transparent: true, opacity: 0.85 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.12, 8, 32), ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.05;
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xffc145, transparent: true, opacity: 0.16 });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 8, 12, 1, true), beamMat);
    beam.position.y = 4;
    missionMarker.add(ring, beam);
    missionMarker.userData.ring = ring;
    missionMarker.userData.beam = beam;

    const packageSlot = new THREE.Group();
    packageSlot.position.y = 1.4;
    if (packageGltf) {
      const box = extractRandomVariant(packageGltf);
      const bbox = new THREE.Box3().setFromObject(box);
      const size = new THREE.Vector3();
      bbox.getSize(size);
      const scale = 0.9 / Math.max(size.x, size.y, size.z, 0.01);
      box.scale.setScalar(scale);
      enableShadows(box);
      packageSlot.add(box);
    } else {
      const boxMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.5, 0.6),
        new THREE.MeshStandardMaterial({ color: 0xc69154, roughness: 0.9 })
      );
      enableShadows(boxMesh);
      packageSlot.add(boxMesh);
    }
    missionMarker.add(packageSlot);
    missionMarker.userData.packageSlot = packageSlot;
    missionMarker.visible = false;
    scene.add(missionMarker);
  }

  function setMissionMarkerColor(hex) {
    missionMarker.userData.ring.material.color.setHex(hex);
    missionMarker.userData.beam.material.color.setHex(hex);
  }

  function attachCarriedPackage() {
    if (!carGroup) return;
    if (carriedPackageMesh) carGroup.remove(carriedPackageMesh);
    if (packageGltf) {
      carriedPackageMesh = extractRandomVariant(packageGltf);
      const box = new THREE.Box3().setFromObject(carriedPackageMesh);
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = 0.5 / Math.max(size.x, size.y, size.z, 0.01);
      carriedPackageMesh.scale.setScalar(scale);
    } else {
      carriedPackageMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, 0.35, 0.4),
        new THREE.MeshStandardMaterial({ color: 0xc69154, roughness: 0.9 })
      );
    }
    carriedPackageMesh.position.set(0, 1.0, -0.4); // sits on the trunk/roof, in the car's local space
    enableShadows(carriedPackageMesh);
    carGroup.add(carriedPackageMesh);
  }

  function clearCarriedPackage() {
    if (carriedPackageMesh && carGroup) carGroup.remove(carriedPackageMesh);
    carriedPackageMesh = null;
  }

  function startMission() {
    const [pickup, dropoff] = pickTwoDistinctWaypoints();
    const dist = pickup.position.distanceTo(dropoff.position);
    const timeLimit = Math.max(35, (dist / 14) * 1.35 + 10);
    mission = { pickup, dropoff, timeLimit, timeLeft: timeLimit, phase: 'to-pickup' };
    ui.updateMission(mission);
    clearCarriedPackage();
    if (missionMarker) {
      missionMarker.visible = true;
      missionMarker.position.copy(pickup.position);
      setMissionMarkerColor(0xffc145);
      missionMarker.userData.packageSlot.visible = true;
    }
  }

  function updateMission(dt) {
    if (currentMode !== 'delivery' || !mission || !carGroup) return;
    mission.timeLeft -= dt;
    if (missionMarker && missionMarker.visible) {
      missionMarker.userData.packageSlot.rotation.y += dt * 1.5;
      missionMarker.rotation.y += dt * 0.3;
    }
    const carPos = carGroup.position;
    if (mission.phase === 'to-pickup') {
      if (carPos.distanceTo(mission.pickup.position) < 4) {
        mission.phase = 'to-dropoff';
        audio.playCoin();
        ui.showToast('Package picked up! Head to the drop-off.');
        attachCarriedPackage();
        if (missionMarker) {
          missionMarker.position.copy(mission.dropoff.position);
          setMissionMarkerColor(0x33e0ff);
          missionMarker.userData.packageSlot.visible = false;
        }
      }
    } else if (mission.phase === 'to-dropoff') {
      if (carPos.distanceTo(mission.dropoff.position) < 4) {
        completeMission();
        return;
      }
    }
    if (mission.timeLeft <= 0) {
      ui.showToast('Delivery expired — no reward this time.');
      startMission();
      return;
    }
    ui.updateMission(mission);
  }

  function completeMission() {
    const ratio = Math.max(0, mission.timeLeft / mission.timeLimit);
    let stars = 1;
    if (ratio > 0.8) stars = 5;
    else if (ratio > 0.6) stars = 4;
    else if (ratio > 0.4) stars = 3;
    else if (ratio > 0.2) stars = 2;
    const reward = STAR_REWARDS[stars];
    AppState.money += reward;
    persist(AppState);
    audio.playStarChime(stars);
    ui.showDeliveryResult(stars, reward);
    clearCarriedPackage();
    startMission();
  }

  // --- Collision callbacks from physics.js ---------------------------------
  // physics.js is constructed in main.js before this module exists, so the
  // callbacks it holds are indirections that get pointed at the real
  // functions below via setCollisionHandlers() once createGame() returns.

  // A sustained scrape against a wall fires many 'collide' events per
  // second from cannon-es — without a cooldown, that reads as health
  // draining almost instantly from what should be one small bump.
  let lastDamageAt = 0;
  const DAMAGE_COOLDOWN_MS = 500;

  function onNPCHit(npc, relVel) {
    if (currentMode === 'menu') return;
    const now = performance.now();
    if (now - lastDamageAt < DAMAGE_COOLDOWN_MS) return;
    lastDamageAt = now;
    const damage = Math.min(2.5, 0.4 + relVel * 0.12);
    AppState.health = Math.max(0, AppState.health - damage);
    audio.playCrash(0.5);
    ui.updateHealth(AppState.health);
    ui.pulseHealth();
    persist(AppState);
  }

  function onImpact(relVel) {
    if (currentMode === 'menu') return;
    const now = performance.now();
    if (now - lastDamageAt < DAMAGE_COOLDOWN_MS) return;
    lastDamageAt = now;
    const damage = Math.min(5, relVel * 0.3);
    AppState.health = Math.max(0, AppState.health - damage);
    audio.playCrash(Math.min(1, relVel / 12));
    ui.updateHealth(AppState.health);
    persist(AppState);
  }

  // --- Main loop --------------------------------------------------------
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    if (paused) return;

    if (currentMode === 'menu') {
      applyMenuSunset();
      updateMenuCamera(dt);
    } else if (carGroup) {
      updateDayNight(dt);
      physics.setInput(InputState);
      const telemetry = physics.step(dt);
      const body = physics.getCarBody();
      carGroup.position.copy(body.position);
      carGroup.quaternion.copy(body.quaternion);
      updateChaseCamera(dt);
      audio.updateEngine(telemetry.speedRatio, InputState.throttle);
      ui.updateSpeed(telemetry.speedAbs || 0, getEffectiveStats(AppState.activeCar).topSpeed);

      if (telemetry.isSkidding && Math.random() > 0.4) {
        const rearOffset = new THREE.Vector3(0.6 * (Math.random() > 0.5 ? 1 : -1), 0, -1.7).applyQuaternion(carGroup.quaternion).add(carGroup.position);
        spawnSkidMark(rearOffset, carGroup.rotation.y);
        audio.playSkid(Math.abs(InputState.steer) + 0.3);
      }
      updateSkidMarks(dt);
      updateNPCMeshes(dt);
      updateCoins(dt);
      updateMission(dt);
    }

    renderMain();
  }

  function updateNPCMeshes(dt) {
    for (const n of npcMeshes) {
      n.mesh.position.copy(n.entity.body.position);
      n.mesh.position.y -= 0.85;
      if (!n.entity.ragdoll && n.entity.facing !== undefined) {
        n.mesh.rotation.set(0, n.entity.facing, 0);
      } else if (n.entity.ragdoll) {
        n.mesh.quaternion.copy(n.entity.body.quaternion);
      }
      if (n.mixer) n.mixer.update(dt);
    }
  }

  function updateCoins(dt) {
    if (!carGroup) return;
    for (let i = coinPickups.length - 1; i >= 0; i--) {
      const c = coinPickups[i];
      c.spin += dt * 3;
      c.mesh.rotation.y = c.spin;
      if (c.mesh.position.distanceTo(carGroup.position) < 2.2) {
        scene.remove(c.mesh);
        coinPickups.splice(i, 1);
        AppState.money += 2;
        persist(AppState);
        audio.playCoin();
        ui.updateMoney(AppState.money);
        if (currentMode === 'freedrive') spawnCoin();
      }
    }
  }

  function renderMain() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setViewport(0, 0, w, h);
    renderer.setScissorTest(false);
    composer.render();

    if (currentMode !== 'menu' && carGroup) {
      const mmSize = Math.floor(Math.min(w, h) * 0.28);
      const margin = 16;
      minimapCamera.position.set(carGroup.position.x, 120, carGroup.position.z);
      minimapCamera.lookAt(carGroup.position.x, 0, carGroup.position.z);
      renderer.setScissorTest(true);
      renderer.setScissor(w - mmSize - margin, h - mmSize - margin, mmSize, mmSize);
      renderer.setViewport(w - mmSize - margin, h - mmSize - margin, mmSize, mmSize);
      const prevFog = scene.fog;
      scene.fog = null;
      renderer.clear();
      renderer.render(scene, minimapCamera);
      scene.fog = prevFog;
      renderer.setScissorTest(false);
    }
  }

  // --- Public API -------------------------------------------------------
  async function init() {
    resize();
    await buildCity();
    await setActiveCar(AppState.activeCar);
    currentMode = 'menu';
    running = true;
    animate();
  }

  async function selectCar(carId) {
    AppState.activeCar = carId;
    persist(AppState);
    await setActiveCar(carId);
  }

  function startRun(mode) {
    currentMode = mode;
    paused = false;
    physics.resetCar({ x: 0, y: 1.2, z: 15 });
    AppState.health = Math.max(AppState.health, 40);
    ui.updateHealth(AppState.health);
    ui.updateMoney(AppState.money);
    audio.startEngine();
    if (mode === 'delivery') {
      startMission();
    } else {
      mission = null;
      ui.updateMission(null);
      if (missionMarker) missionMarker.visible = false;
      clearCarriedPackage();
    }
  }

  function pause() { paused = true; }
  function resume() { paused = false; clock.getDelta(); }
  function quitToMenu() {
    currentMode = 'menu';
    audio.stopEngine();
    if (missionMarker) missionMarker.visible = false;
    clearCarriedPackage();
    InputState.steer = 0; InputState.throttle = 0; InputState.brake = 0;
  }

  function repairCar() {
    if (AppState.money < REPAIR_COST || AppState.health >= 100) return false;
    AppState.money -= REPAIR_COST;
    AppState.health = 100;
    persist(AppState);
    return true;
  }

  function upgradeCar(carId) {
    const level = AppState.upgrades[carId] || 0;
    if (level >= MAX_UPGRADE_LEVEL) return false;
    const cost = UPGRADE_BASE_COST * (level + 1);
    if (AppState.money < cost) return false;
    AppState.money -= cost;
    AppState.upgrades[carId] = level + 1;
    persist(AppState);
    if (carId === AppState.activeCar) physics.setCarStats(getEffectiveStats(carId));
    return true;
  }

  function buyCar(carId) {
    const def = CAR_CATALOG[carId];
    if (AppState.ownedCars.includes(carId) || AppState.money < def.price) return false;
    AppState.money -= def.price;
    AppState.ownedCars.push(carId);
    persist(AppState);
    return true;
  }

  return {
    init, selectCar, startRun, pause, resume, quitToMenu,
    repairCar, upgradeCar, buyCar,
    getEffectiveStats,
    setCollisionHandlers: () => ({ onNPCHit, onImpact })
  };
}
