// main.js — Application bootstrap.
//
// This file owns the two pieces of shared mutable state (AppState, InputState)
// and wires the four independent modules together via dependency injection.
// No module here imports another circularly — see game.js's header comment.

import { createAudioEngine } from './audio.js';
import { createPhysicsWorld } from './physics.js';
import { createUI } from './ui.js';
import { createGame, CAR_ORDER } from './game.js';

const STORAGE_KEY = 'ride_save_v1';

function defaultState() {
  const upgrades = {};
  for (const id of CAR_ORDER) upgrades[id] = 0;
  return {
    money: 100,
    ownedCars: ['suzuki'],
    activeCar: 'suzuki',
    upgrades,
    health: 100
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed, upgrades: { ...defaultState().upgrades, ...(parsed.upgrades || {}) } };
  } catch (err) {
    console.warn('[RIDE] Save data was unreadable, starting fresh.', err);
    return defaultState();
  }
}

function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn('[RIDE] Could not save progress (storage may be full or disabled).', err);
  }
}

const AppState = loadState();
const InputState = { steer: 0, throttle: 0, brake: 0 };

const audio = createAudioEngine();
window.addEventListener('pointerdown', () => audio.unlock(), { once: true });
window.addEventListener('touchstart', () => audio.unlock(), { once: true });

// physics.js needs collision callbacks at construction time, but the real
// handler logic lives inside game.js (closures over scene/AppState/ui).
// This small indirection object lets us wire them up after createGame() runs.
const collisionRelay = {
  onNPCHit: () => {},
  onImpact: () => {}
};
const physics = createPhysicsWorld({
  onNPCHit: (npc, relVel) => collisionRelay.onNPCHit(npc, relVel),
  onImpact: (relVel, prop) => collisionRelay.onImpact(relVel, prop)
});

const ui = createUI(AppState, InputState, {
  onPlayFreeDrive: () => game.startRun('freedrive'),
  onPlayDelivery: () => game.startRun('delivery'),
  onSelectCar: (carId) => game.selectCar(carId),
  onBuyCar: (carId) => game.buyCar(carId),
  onUpgrade: (carId) => game.upgradeCar(carId),
  onRepair: () => game.repairCar(),
  onPause: () => game.pause(),
  onResume: () => game.resume(),
  onQuit: () => game.quitToMenu(),
  onToggleMute: () => audio.toggleMute()
}, audio);

const game = createGame(AppState, InputState, physics, ui, audio, persist);
Object.assign(collisionRelay, game.setCollisionHandlers());

const loadingScreen = document.getElementById('loading-screen');
const loadingLabel = document.getElementById('loading-label');

game.init()
  .then(() => {
    loadingScreen.classList.add('hidden');
    ui.showMainMenu();
  })
  .catch((err) => {
    console.error('[RIDE] Failed to initialize the game', err);
    if (loadingLabel) loadingLabel.textContent = 'Something went wrong loading RIDE. Please refresh.';
  });

// --- PWA registration -------------------------------------------------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[RIDE] Service worker registration failed', err);
    });
  });
}

// Install prompt (Android/Chrome "Add to Home Screen")
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const installBtn = document.getElementById('btn-install');
  if (installBtn) installBtn.classList.remove('hidden');
});
document.getElementById('btn-install')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById('btn-install').classList.add('hidden');
});
