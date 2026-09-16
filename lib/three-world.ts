import * as T from 'three';
import { random } from './world';
import type { Recipe } from './asset-recipe';
export function disposeScene(root: T.Object3D) {
  root.traverse((o) => {
    if (o instanceof T.Mesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => m.dispose());
    }
  });
}
function mat(color: T.ColorRepresentation) {
  return new T.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
}
function mesh(
  parent: T.Object3D,
  g: T.BufferGeometry,
  color: T.ColorRepresentation,
  x = 0,
  y = 0,
  z = 0,
  sx = 1,
  sy = 1,
  sz = 1,
) {
  const m = new T.Mesh(g, mat(color));
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
function ball(
  parent: T.Object3D,
  color: T.ColorRepresentation,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
) {
  return mesh(
    parent,
    new T.IcosahedronGeometry(1, 1),
    color,
    x,
    y,
    z,
    sx,
    sy,
    sz,
  );
}
function limb(
  parent: T.Object3D,
  a: T.Vector3,
  b: T.Vector3,
  r: number,
  color: T.ColorRepresentation,
) {
  const delta = b.clone().sub(a);
  const m = mesh(
    parent,
    new T.CylinderGeometry(r * 0.65, r, delta.length(), 5),
    color,
  );
  m.position.copy(a.clone().add(b).multiplyScalar(0.5));
  m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), delta.normalize());
  return m;
}
const palettes = [
  '#93cec8',
  '#c7a4b5',
  '#d2c385',
  '#a7aed2',
  '#d2ac87',
  '#b8c99a',
];
export function creature(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    group = new T.Group();
  const color = new T.Color(
    opts?.color ?? palettes[Math.floor(r() * palettes.length)],
  );
  const dark = color.clone().multiplyScalar(0.7),
    light = color.clone().lerp(new T.Color('#e6e8cf'), 0.45);
  const width = (0.68 + r() * 0.32) * (opts?.width ?? 1),
    height = (0.65 + r() * 0.4) * (opts?.height ?? 1);
  const headGeo = new T.SphereGeometry(1, 14, 10);
  const pos = headGeo.attributes.position;
  const phase = r() * 10;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const bulge =
      1 +
      (opts?.roughness ?? 0.12) *
        Math.sin(x * 7 + phase) *
        Math.cos(y * 6 + phase) +
      (opts?.roughness ?? 0.12) * 0.4 * Math.sin(z * 11 + phase);
    pos.setXYZ(i, x * width * bulge, y * height * bulge, z * 0.65 * bulge);
  }
  headGeo.computeVertexNormals();
  const head = mesh(group, headGeo, color, 0, 1.46, 0);
  head.rotation.z = (r() - 0.5) * 0.2;
  ball(group, '#dedec6', 0, 0.49, 0, 0.32, 0.25, 0.23);
  const legs: T.Mesh[] = [];
  for (const side of [-1, 1]) {
    legs.push(
      limb(
        group,
        new T.Vector3(side * 0.16, 0.36, 0),
        new T.Vector3(side * 0.19, 0.04, 0.03),
        0.055,
        color,
      ),
    );
    ball(group, color, side * 0.2, 0.045, 0.13, 0.11, 0.05, 0.16);
    limb(
      group,
      new T.Vector3(side * 0.28, 0.57, 0),
      new T.Vector3(side * 0.44, 0.36, 0.05),
      0.05,
      '#dedec6',
    );
    ball(
      group,
      light,
      side * (width - 0.02),
      1.65,
      -0.02,
      0.27 * (opts?.ears ?? 1),
      0.35 * (opts?.ears ?? 1),
      0.15 * (opts?.ears ?? 1),
    );
  }
  const eyes = opts?.eyes ?? 2 + Math.floor(r() * 3);
  for (let i = 0; i < eyes; i++) {
    const angle = eyes === 1 ? 0 : (i / (eyes - 1) - 0.5) * 1.7;
    const x = Math.sin(angle) * width * 0.67,
      y = 1.64 + (i % 2) * 0.19;
    ball(group, dark, x, y, 0.52, 0.2, 0.21, 0.12);
    ball(group, '#e5d279', x, y, 0.625, 0.1, 0.105, 0.045);
    ball(group, '#434c3b', x + 0.02, y - 0.01, 0.67, 0.026, 0.055, 0.012);
  }
  const mouthWidth = width * (0.66 + r() * 0.1);
  ball(group, dark, 0, 1.05, 0.51, mouthWidth + 0.07, 0.33, 0.15);
  ball(group, '#30231c', 0, 1.07, 0.635, mouthWidth, 0.27, 0.065);
  const teeth = opts?.teeth ?? 4 + Math.floor(r() * 4);
  for (let i = 0; i < teeth; i++) {
    const xx = teeth === 1 ? 0 : (i / (teeth - 1) - 0.5) * mouthWidth * 1.55;
    mesh(
      group,
      new T.BoxGeometry(0.052 + r() * 0.025, 0.06 + r() * 0.045, 0.04),
      '#ede6cc',
      xx,
      1.23 - r() * 0.035,
      0.694,
    );
  }
  const horns = opts?.horns ?? 2 + Math.floor(r() * 5);
  for (let i = 0; i < horns; i++) {
    const x = horns === 1 ? 0 : (i / (horns - 1) - 0.5) * width * 1.5;
    const y = 1.46 + height * Math.sqrt(Math.max(0, 1 - (x / width) ** 2));
    const horn = mesh(
      group,
      new T.ConeGeometry(0.07 + r() * 0.065, 0.25 + r() * 0.5, 4),
      light,
      x,
      y + 0.13,
      -0.05,
    );
    horn.rotation.z = -x * 0.35;
  }
  for (let i = 0; i < 7; i++) {
    const angle = r() * Math.PI * 2;
    ball(
      group,
      i % 2 ? light : dark,
      Math.cos(angle) * width * 0.8,
      1.45 + Math.sin(angle) * height * 0.7,
      0.32 + r() * 0.13,
      0.08 + r() * 0.12,
      0.06 + r() * 0.12,
      0.08,
    );
  }
  return group;
}
export function habitat(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group();
  const groundColors = ['#596c50', '#626c53', '#50675c'];
  const ground = opts?.color ?? groundColors[Math.floor(r() * 3)];
  const island = mesh(
    g,
    new T.CylinderGeometry(7.9, 6.2, 1.45, 11, 1),
    '#3d4640',
    0,
    -0.8,
    0,
    1,
    0.9,
    0.69,
  );
  island.rotation.y = r();
  const top = mesh(
    g,
    new T.CylinderGeometry(7.9, 7.7, 0.25, 11, 1),
    ground,
    0,
    -0.07,
    0,
    1,
    1,
    0.69,
  );
  top.rotation.y = island.rotation.y;
  for (let i = 0; i < (opts?.rocks ?? 24); i++) {
    const a = r() * Math.PI * 2,
      rad = 6.9 + r() * 0.7;
    ball(
      g,
      i % 2 ? '#647366' : '#465447',
      Math.cos(a) * rad,
      -0.4 - r() * 0.7,
      Math.sin(a) * rad * 0.62,
      0.4 + r() * 0.6,
      0.4 + r() * 0.5,
      0.4 + r() * 0.5,
    );
  }
  // Faceted pond, ringed with pebbles.
  if (opts?.pond !== false) {
    const pondX = 4.3 + (r() - 0.5),
      pondZ = 0.2 + r();
    mesh(
      g,
      new T.CylinderGeometry(1.1, 1.2, 0.07, 12),
      '#6c9c9d',
      pondX,
      0.085,
      pondZ,
      1.25,
      1,
      0.8,
    );
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ball(
        g,
        '#9d9d85',
        pondX + Math.cos(a) * 1.5,
        0.15,
        pondZ + Math.sin(a),
        0.13 + r() * 0.12,
        0.1,
        0.12 + r() * 0.1,
      );
    }
  }
  // A footpath assembled from irregular stones.
  for (let i = 0; i < 32; i++) {
    const x = -6.3 + i * 0.4,
      z = Math.sin(i * 0.18) * 0.45 + 0.5;
    const tile = mesh(
      g,
      new T.CylinderGeometry(0.31, 0.34, 0.06, 5),
      '#b2a889',
      x,
      0.1,
      z,
      1.1,
      1,
      0.75,
    );
    tile.rotation.y = r() * 3;
  }
  for (let i = 0; i < (opts?.huts ?? 3); i++) {
    const x = -5 + i * (10 / Math.max(1, (opts?.huts ?? 3) - 1)) + r() * 0.4,
      z = -2.3 - r() * 0.6;
    const hut = new T.Group();
    hut.position.set(x, 0, z);
    g.add(hut);
    mesh(hut, new T.CylinderGeometry(0.7, 0.83, 1.05, 7), '#b4ae8e', 0, 0.6, 0);
    const roof = mesh(
      hut,
      new T.ConeGeometry(1.2, 0.9, 7),
      i % 2 ? '#9d7d7d' : '#7c9c94',
      0,
      1.55,
      0,
    );
    roof.rotation.y = r();
    mesh(hut, new T.BoxGeometry(0.3, 0.65, 0.06), '#373b30', 0, 0.4, 0.75);
    mesh(hut, new T.BoxGeometry(0.16, 0.18, 0.04), '#e2cc86', 0.4, 0.75, 0.68);
    mesh(
      hut,
      new T.CylinderGeometry(0.13, 0.16, 0.65, 5),
      '#afa68d',
      -0.4,
      1.85,
      0,
    );
  }
  for (let i = 0; i < (opts?.trees ?? 14); i++) {
    const a = Math.PI * 0.12 + r() * Math.PI * 0.8;
    const x = Math.cos(a) * 7,
      z = -Math.sin(a) * 4.2;
    const h = 1.2 + r() * 1.7;
    limb(
      g,
      new T.Vector3(x, 0, z),
      new T.Vector3(x + 0.15, h, z),
      0.15,
      '#807862',
    );
    for (let j = 0; j < 3; j++)
      ball(
        g,
        j % 2 ? '#a0b28a' : '#809977',
        x + (r() - 0.5) * 0.6,
        h - 0.3 + j * 0.4,
        z + (r() - 0.5) * 0.4,
        0.5 + r() * 0.3,
        0.6,
        0.5,
      );
  }
  for (let i = 0; i < (opts?.plants ?? 65); i++) {
    const x = (r() - 0.5) * 13,
      z = (r() - 0.5) * 7.2;
    if (Math.abs(z + 0.1) < 0.6 || (x > 2.7 && z > -0.7 && z < 2.7)) continue;
    const h = 0.1 + r() * 0.25;
    mesh(
      g,
      new T.CylinderGeometry(0.025, 0.04, h, 4),
      '#bcc59b',
      x,
      h / 2 + 0.12,
      z,
    );
    mesh(
      g,
      new T.ConeGeometry(0.1 + r() * 0.1, 0.13, 6),
      i % 3 ? '#bab990' : '#c09f97',
      x,
      h + 0.15,
      z,
    );
  }
  return g;
}
export function lighting(scene: T.Scene) {
  scene.add(new T.HemisphereLight('#e2e6d8', '#56635d', 2.2));
  const sun = new T.DirectionalLight('#fff0cf', 3);
  sun.position.set(-5, 10, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.left = -12;
  sun.shadow.camera.right = 12;
  sun.shadow.camera.top = 10;
  sun.shadow.camera.bottom = -10;
  sun.shadow.normalBias = 0.06;
  scene.add(sun);
}
