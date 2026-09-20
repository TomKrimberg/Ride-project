// ui.js — Menus, garage, HUD and mobile touch controls.
// Pure DOM/CSS manipulation; no framework. Reads car data from game.js
// (one-directional import — game.js never imports ui.js back, see game.js
// header comment for why that matters).

import {
  CAR_CATALOG, CAR_ORDER, REPAIR_COST, MAX_UPGRADE_LEVEL,
  UPGRADE_BASE_COST, UPGRADE_SPEED_BONUS
} from './game.js';

export function createUI(AppState, InputState, handlers, audio) {
  const $ = (id) => document.getElementById(id);

  const screens = {
    loading: $('loading-screen'),
    mainMenu: $('main-menu'),
    modeSelect: $('mode-select'),
    garage: $('garage-screen'),
    settings: $('settings-screen'),
    hud: $('hud-screen'),
    pause: $('pause-menu')
  };

  function showScreen(name) {
    for (const key in screens) {
      if (!screens[key]) continue;
      screens[key].classList.toggle('hidden', key !== name);
    }
  }

  function withClick(el, fn) {
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      audio.playClick();
      fn();
    });
  }

  // --- Main menu -----------------------------------------------------------
  function refreshMoneyDisplays() {
    $('main-menu-money').textContent = AppState.money;
    $('garage-money').textContent = AppState.money;
    $('hud-money').textContent = AppState.money;
  }

  function showMainMenu() {
    showScreen('mainMenu');
    document.getElementById('touch-controls').classList.add('hidden');
    refreshMoneyDisplays();
  }

  withClick($('btn-play'), () => showScreen('modeSelect'));
  withClick($('btn-mode-back'), () => showScreen('mainMenu'));
  withClick($('btn-freedrive'), () => {
    handlers.onPlayFreeDrive();
    enterGameHud();
  });
  withClick($('btn-delivery'), () => {
    handlers.onPlayDelivery();
    enterGameHud();
  });
  withClick($('btn-garage'), () => { renderGarage(); showScreen('garage'); });
  withClick($('btn-garage-back'), () => showMainMenu());
  withClick($('btn-settings'), () => { refreshSettings(); showScreen('settings'); });
  withClick($('btn-settings-back'), () => showMainMenu());

  function enterGameHud() {
    showScreen('hud');
    document.getElementById('touch-controls').classList.remove('hidden');
    refreshMoneyDisplays();
  }

  // --- Settings --------------------------------------------------------
  function refreshSettings() {
    $('btn-toggle-mute').textContent = audio.isMuted() ? 'Unmute audio' : 'Mute audio';
  }
  withClick($('btn-toggle-mute'), () => {
    handlers.onToggleMute();
    refreshSettings();
  });

  // --- Garage ------------------------------------------------------------
  function renderGarage() {
    refreshMoneyDisplays();
    const list = $('garage-car-list');
    list.innerHTML = '';
    for (const carId of CAR_ORDER) {
      const def = CAR_CATALOG[carId];
      const owned = AppState.ownedCars.includes(carId);
      const active = AppState.activeCar === carId;
      const level = AppState.upgrades[carId] || 0;
      const topSpeed = Math.round(def.baseTopSpeed * (1 + level * UPGRADE_SPEED_BONUS) * 3.2); // display units

      const card = document.createElement('div');
      card.className = 'car-card' + (active ? ' car-card--active' : '');
      card.style.setProperty('--car-accent', '#' + def.color.toString(16).padStart(6, '0'));

      const upgradeCost = UPGRADE_BASE_COST * (level + 1);
      const upgradeLabel = level >= MAX_UPGRADE_LEVEL ? 'Max upgrade' : `Upgrade top speed — ${upgradeCost}c`;

      card.innerHTML = `
        <div class="car-card__accent"></div>
        <div class="car-card__body">
          <h3>${def.name}</h3>
          <div class="car-card__stats">
            <span>Top speed <strong>${topSpeed}</strong></span>
            <span>Upgrade lvl <strong>${level}/${MAX_UPGRADE_LEVEL}</strong></span>
          </div>
          <div class="car-card__actions"></div>
        </div>
      `;

      const actions = card.querySelector('.car-card__actions');

      if (!owned) {
        const buyBtn = document.createElement('button');
        buyBtn.className = 'btn btn--accent';
        buyBtn.textContent = `Buy — ${def.price}c`;
        buyBtn.disabled = AppState.money < def.price;
        buyBtn.addEventListener('click', () => {
          audio.playClick();
          if (handlers.onBuyCar(carId)) { audio.playCoin(); renderGarage(); }
        });
        actions.appendChild(buyBtn);
      } else {
        const selectBtn = document.createElement('button');
        selectBtn.className = 'btn' + (active ? ' btn--disabled' : ' btn--ghost');
        selectBtn.textContent = active ? 'Selected' : 'Select';
        selectBtn.disabled = active;
        selectBtn.addEventListener('click', () => {
          audio.playClick();
          handlers.onSelectCar(carId);
          renderGarage();
        });
        actions.appendChild(selectBtn);

        const upgradeBtn = document.createElement('button');
        upgradeBtn.className = 'btn btn--ghost';
        upgradeBtn.textContent = upgradeLabel;
        upgradeBtn.disabled = level >= MAX_UPGRADE_LEVEL || AppState.money < upgradeCost;
        upgradeBtn.addEventListener('click', () => {
          audio.playClick();
          if (handlers.onUpgrade(carId)) { audio.playCoin(); renderGarage(); }
        });
        actions.appendChild(upgradeBtn);
      }
      list.appendChild(card);
    }

    const repairBtn = $('btn-repair');
    repairBtn.disabled = AppState.health >= 100 || AppState.money < REPAIR_COST;
    repairBtn.textContent = AppState.health >= 100 ? 'Car undamaged' : `Repair car — ${REPAIR_COST}c`;
  }
  withClick($('btn-repair'), () => {
    if (handlers.onRepair()) { audio.playCoin(); renderGarage(); updateHealth(AppState.health); }
  });

  // --- HUD -----------------------------------------------------------------
  function updateSpeed(speedMs, topSpeedMs) {
    const kmh = Math.round(Math.abs(speedMs) * 3.2);
    $('hud-speed').textContent = kmh;
    const ratio = Math.min(Math.abs(speedMs) / Math.max(topSpeedMs, 1), 1);
    $('hud-speed-fill').style.width = `${ratio * 100}%`;
  }

  function updateMoney(money) {
    $('hud-money').textContent = money;
    $('garage-money') && ($('garage-money').textContent = money);
    $('main-menu-money') && ($('main-menu-money').textContent = money);
  }

  function updateHealth(health) {
    const bar = $('hud-health-fill');
    bar.style.width = `${Math.max(0, health)}%`;
    bar.classList.toggle('hud-health-fill--low', health < 30);
  }

  let healthPulseTimeout = null;
  function pulseHealth() {
    const panel = $('hud-health-panel');
    panel.classList.add('pulse');
    clearTimeout(healthPulseTimeout);
    healthPulseTimeout = setTimeout(() => panel.classList.remove('pulse'), 350);
  }

  function updateMission(mission) {
    const panel = $('hud-mission-panel');
    if (!mission) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    $('hud-mission-text').textContent = mission.phase === 'to-pickup'
      ? 'Drive to the pickup point'
      : 'Deliver the package';
    $('hud-mission-timer').textContent = Math.max(0, mission.timeLeft).toFixed(0) + 's';
  }

  let toastTimeout = null;
  function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('toast--visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => el.classList.remove('toast--visible'), 2600);
  }

  function showDeliveryResult(stars, reward) {
    const modal = $('delivery-result');
    const starsEl = $('delivery-result-stars');
    starsEl.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const span = document.createElement('span');
      span.className = 'star' + (i < stars ? ' star--filled' : '');
      span.textContent = '★';
      starsEl.appendChild(span);
    }
    $('delivery-result-reward').textContent = `+${reward} coins`;
    modal.classList.add('delivery-result--visible');
    updateMoney(AppState.money);
    setTimeout(() => modal.classList.remove('delivery-result--visible'), 2200);
  }

  // --- Pause -----------------------------------------------------------
  withClick($('btn-pause'), () => {
    handlers.onPause();
    showScreen('pause');
  });
  withClick($('btn-resume'), () => {
    handlers.onResume();
    showScreen('hud');
  });
  withClick($('btn-quit'), () => {
    handlers.onQuit();
    showMainMenu();
  });

  // --- Touch controls -------------------------------------------------------
  function setupJoystick() {
    const base = $('joystick-base');
    const nub = $('joystick-nub');
    let activeId = null;
    const radius = 42;

    function setFromEvent(clientX, clientY) {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let dx = clientX - cx;
      let dy = clientY - cy;
      const dist = Math.min(Math.hypot(dx, dy), radius);
      const angle = Math.atan2(dy, dx);
      dx = Math.cos(angle) * dist;
      dy = Math.sin(angle) * dist;
      nub.style.transform = `translate(${dx}px, ${dy}px)`;
      InputState.steer = Math.max(-1, Math.min(1, dx / radius));
    }

    function reset() {
      nub.style.transform = 'translate(0px, 0px)';
      InputState.steer = 0;
      activeId = null;
    }

    base.addEventListener('pointerdown', (e) => {
      activeId = e.pointerId;
      base.setPointerCapture(activeId);
      setFromEvent(e.clientX, e.clientY);
    });
    base.addEventListener('pointermove', (e) => {
      if (activeId !== e.pointerId) return;
      setFromEvent(e.clientX, e.clientY);
    });
    base.addEventListener('pointerup', reset);
    base.addEventListener('pointercancel', reset);
  }

  function setupHoldButton(id, onDown, onUp) {
    const el = $(id);
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); onDown(); });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('pointerleave', onUp);
  }

  setupJoystick();
  setupHoldButton('btn-gas', () => { InputState.throttle = 1; }, () => { InputState.throttle = 0; });
  setupHoldButton('btn-brake', () => { InputState.brake = 1; }, () => { InputState.brake = 0; });
  setupHoldButton('btn-drift', () => { InputState.drift = true; }, () => { InputState.drift = false; });

  return {
    showMainMenu,
    renderGarage,
    updateSpeed,
    updateMoney,
    updateHealth,
    pulseHealth,
    updateMission,
    showToast,
    showDeliveryResult
  };
}
