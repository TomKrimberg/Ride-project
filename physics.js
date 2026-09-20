// physics.js — Cannon-es integration.
//
// Architectural note: a full raycast-vehicle simulation (per-wheel suspension,
// slip curves) is expensive on mobile GPUs/CPUs and mostly invisible in a
// third-person arcade camera. Instead this uses a single rigid chassis body
// with a simplified longitudinal force + lateral "grip" model, which is the
// same technique used by most mobile arcade racers (cheap, stable, and easy
// to tune for a fun drift feel).

import * as CANNON from 'cannon-es';

export function createPhysicsWorld(callbacks = {}) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.solver.iterations = 8;

  const groundMaterial = new CANNON.Material('ground');
  const carMaterial = new CANNON.Material('car');
  const propMaterial = new CANNON.Material('prop');

  world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, carMaterial, {
    friction: 0.15, restitution: 0.05
  }));
  world.addContactMaterial(new CANNON.ContactMaterial(carMaterial, propMaterial, {
    friction: 0.3, restitution: 0.15
  }));

  // Static ground plane
  const groundBody = new CANNON.Body({ mass: 0, material: groundMaterial });
  groundBody.addShape(new CANNON.Plane());
  groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
  world.addBody(groundBody);

  let carBody = null;
  let carStats = { mass: 140, topSpeed: 34, accel: 22, turnRate: 2.4, grip: 0.9, driftGrip: 0.5 };
  const input = { steer: 0, throttle: 0, brake: 0 };
  const npcEntities = [];
  const propEntities = [];

  function createCarBody(stats, spawnPosition = { x: 0, y: 1, z: 0 }) {
    carStats = stats;
    if (carBody) world.removeBody(carBody);
    const shape = new CANNON.Box(new CANNON.Vec3(0.9, 0.55, 1.95));
    carBody = new CANNON.Body({
      mass: stats.mass,
      shape,
      material: carMaterial,
      position: new CANNON.Vec3(spawnPosition.x, spawnPosition.y, spawnPosition.z),
      linearDamping: 0.2,
      angularDamping: 0.92
    });
    carBody.addEventListener('collide', (e) => onCarCollide(e));
    world.addBody(carBody);
    return carBody;
  }

  function setCarStats(stats) {
    carStats = { ...carStats, ...stats };
  }

  function setInput(next) {
    Object.assign(input, next);
  }

  function onCarCollide(e) {
    const other = e.body;
    const npc = npcEntities.find((n) => n.body === other);
    const relVel = carBody.velocity.vsub(other.velocity).length();
    if (npc && relVel > 1.5) {
      applyRagdollImpulse(npc, relVel);
      callbacks.onNPCHit && callbacks.onNPCHit(npc, relVel);
      return;
    }
    const prop = propEntities.find((p) => p.body === other);
    if (relVel > 3) {
      callbacks.onImpact && callbacks.onImpact(relVel, prop || null);
    }
  }

  function applyRagdollImpulse(npc, relVel) {
    if (npc.ragdoll) return;
    npc.ragdoll = true;
    npc.ragdollTimer = 4 + Math.random() * 2;
    const dir = carBody.velocity.clone();
    dir.y = Math.max(dir.y, 1.5);
    npc.body.wakeUp();
    npc.body.applyImpulse(dir.scale(npc.body.mass * 0.9), npc.body.position);
    npc.body.angularVelocity.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 12
    );
  }

  function addNPC(startPosition, waypoints, walkSpeed = 1.2) {
    const shape = new CANNON.Cylinder(0.28, 0.28, 1.6, 8);
    const body = new CANNON.Body({
      mass: 6,
      shape,
      material: propMaterial,
      position: new CANNON.Vec3(startPosition.x, 0.85, startPosition.z),
      angularDamping: 0.9,
      linearDamping: 0.5
    });
    body.fixedRotation = true; // walking NPCs stay upright until ragdolled
    body.updateMassProperties();
    world.addBody(body);
    const npc = { body, waypoints, wpIndex: 0, walkSpeed, ragdoll: false, ragdollTimer: 0, alive: true };
    npcEntities.push(npc);
    return npc;
  }

  function addProp(position, halfExtents, mass = 0) {
    const shape = new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z));
    const body = new CANNON.Body({
      mass,
      shape,
      material: propMaterial,
      position: new CANNON.Vec3(position.x, position.y, position.z)
    });
    world.addBody(body);
    const prop = { body };
    propEntities.push(prop);
    return prop;
  }

  function stepNPCs(dt) {
    for (const npc of npcEntities) {
      if (npc.ragdoll) {
        npc.ragdollTimer -= dt;
        if (npc.ragdollTimer <= 0) {
          // Recover: stand back up and resume patrol
          npc.ragdoll = false;
          npc.body.fixedRotation = true;
          npc.body.updateMassProperties();
          npc.body.angularVelocity.set(0, 0, 0);
          npc.body.quaternion.set(0, 0, 0, 1);
          npc.body.position.y = 0.85;
        }
        continue;
      }
      if (!npc.waypoints || npc.waypoints.length === 0) continue;
      const target = npc.waypoints[npc.wpIndex];
      const dx = target.x - npc.body.position.x;
      const dz = target.z - npc.body.position.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < 0.6) {
        npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length;
      } else {
        const vx = (dx / dist) * npc.walkSpeed;
        const vz = (dz / dist) * npc.walkSpeed;
        npc.body.velocity.x = vx;
        npc.body.velocity.z = vz;
        npc.facing = Math.atan2(vx, vz);
      }
    }
  }

  // Returns telemetry the caller (game.js) uses for camera, HUD and audio.
  function applyDriving() {
    if (!carBody) return { speed: 0, speedRatio: 0, isSkidding: false };

    const localVel = carBody.quaternion.inverse().vmult(carBody.velocity);
    const forwardSpeed = localVel.z;
    const speedAbs = Math.abs(forwardSpeed);
    const speedRatio = Math.min(speedAbs / carStats.topSpeed, 1);

    // Longitudinal force (throttle / brake / reverse)
    let forceMag = 0;
    if (input.throttle > 0.01 && speedAbs < carStats.topSpeed) {
      forceMag = carStats.accel * input.throttle * carBody.mass;
    } else if (input.brake > 0.01) {
      // Braking while moving forward decelerates; braking while stopped/reversing engages reverse gear
      forceMag = forwardSpeed > 0.5 ? -carStats.accel * 1.6 * input.brake * carBody.mass
                                     : -carStats.accel * 0.5 * input.brake * carBody.mass;
    }
    if (forceMag !== 0) {
      const forward = new CANNON.Vec3(0, 0, 1);
      carBody.quaternion.vmult(forward, forward);
      carBody.applyForce(forward.scale(forceMag), carBody.position);
    }

    // Steering — arcade torque model, scaled down at low speed and near-zero when stationary
    const speedFactor = Math.min(speedAbs / 4, 1);
    const steerSign = forwardSpeed < -0.2 ? -1 : 1;
    const targetAngularY = -input.steer * carStats.turnRate * speedFactor * steerSign;
    carBody.angularVelocity.y += (targetAngularY - carBody.angularVelocity.y) * 0.25;

    // Lateral grip. Automatic drift: a hard turn at speed breaks traction on
    // its own (no dedicated drift button), same as braking hard into a turn.
    const drifting = (Math.abs(input.steer) > 0.55 && speedAbs > 6) ||
                      (input.brake > 0.4 && Math.abs(input.steer) > 0.3 && speedAbs > 4);
    const grip = drifting ? carStats.driftGrip : carStats.grip;
    localVel.x *= (1 - grip);
    const worldVel = carBody.quaternion.vmult(localVel);
    carBody.velocity.x = worldVel.x;
    carBody.velocity.z = worldVel.z;

    const isSkidding = drifting && speedAbs > 3;

    return { speed: forwardSpeed, speedAbs, speedRatio, isSkidding, drifting };
  }

  function step(dt) {
    const telemetry = applyDriving();
    world.step(1 / 60, dt, 6);
    stepNPCs(dt);
    return telemetry;
  }

  function resetCar(position = { x: 0, y: 1, z: 0 }) {
    if (!carBody) return;
    carBody.velocity.set(0, 0, 0);
    carBody.angularVelocity.set(0, 0, 0);
    carBody.quaternion.set(0, 0, 0, 1);
    carBody.position.set(position.x, position.y, position.z);
  }

  return {
    world,
    createCarBody,
    setCarStats,
    setInput,
    addNPC,
    addProp,
    step,
    resetCar,
    getCarBody: () => carBody,
    getNPCs: () => npcEntities,
    getProps: () => propEntities
  };
}
