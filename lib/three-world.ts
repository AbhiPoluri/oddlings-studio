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
function part(m: T.Mesh, name: string) {
  m.userData.rigPart = name;
  return m;
}
export function person(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group();
  const cloth = new T.Color(opts?.color ?? '#8ca6a0');
  const dark = cloth.clone().multiplyScalar(0.55),
    light = cloth.clone().lerp(new T.Color('#eee3c6'), 0.38);
  const skin = ['#d9ad86', '#a97858', '#edc6a1', '#80543e'][
    Math.floor(r() * 4)
  ];
  const w = opts?.width ?? 1,
    h = opts?.height ?? 1;
  part(
    mesh(g, new T.BoxGeometry(0.42 * w, 0.48 * h, 0.25), cloth, 0, 0.98, 0),
    'spine',
  );
  part(
    mesh(g, new T.BoxGeometry(0.34 * w, 0.2, 0.23), dark, 0, 0.68, 0),
    'hips',
  );
  part(ball(g, skin, 0, 1.48 * h, 0, 0.25 * w, 0.29, 0.23), 'head');
  part(
    mesh(
      g,
      new T.CylinderGeometry(0.27 * w, 0.31 * w, 0.18, 6),
      dark,
      0,
      1.67 * h,
      0,
    ),
    'head',
  );
  for (const side of [-1, 1]) {
    const arm = side < 0 ? 'arm_l' : 'arm_r',
      fore = side < 0 ? 'forearm_l' : 'forearm_r';
    part(
      limb(
        g,
        new T.Vector3(side * 0.25 * w, 1.16, 0),
        new T.Vector3(side * 0.39 * w, 0.91, 0.02),
        0.07,
        cloth,
      ),
      arm,
    );
    part(
      limb(
        g,
        new T.Vector3(side * 0.39 * w, 0.91, 0.02),
        new T.Vector3(side * 0.42 * w, 0.68, 0.08),
        0.06,
        skin,
      ),
      fore,
    );
    part(ball(g, skin, side * 0.42 * w, 0.65, 0.09, 0.08, 0.09, 0.07), fore);
    const thigh = side < 0 ? 'thigh_l' : 'thigh_r',
      shin = side < 0 ? 'shin_l' : 'shin_r',
      foot = side < 0 ? 'foot_l' : 'foot_r';
    part(
      limb(
        g,
        new T.Vector3(side * 0.13, 0.65, 0),
        new T.Vector3(side * 0.14, 0.35, 0.015),
        0.09,
        dark,
      ),
      thigh,
    );
    part(
      limb(
        g,
        new T.Vector3(side * 0.14, 0.35, 0.015),
        new T.Vector3(side * 0.14, 0.08, 0.03),
        0.075,
        cloth,
      ),
      shin,
    );
    part(
      mesh(
        g,
        new T.BoxGeometry(0.17, 0.09, 0.29),
        dark,
        side * 0.14,
        0.06,
        0.1,
      ),
      foot,
    );
  }
  for (const side of [-1, 1])
    part(
      ball(g, '#f0e4c8', side * 0.09 * w, 1.5 * h, 0.21, 0.055, 0.07, 0.035),
      'head',
    );
  part(
    mesh(
      g,
      new T.BoxGeometry(0.12, 0.025, 0.025),
      '#5b3c31',
      0,
      1.38 * h,
      0.235,
    ),
    'head',
  );
  const hair = Math.max(1, opts?.horns ?? 3);
  for (let i = 0; i < hair; i++) {
    const a = (i / (Math.max(2, hair) - 1) - 0.5) * 1.6;
    part(
      mesh(
        g,
        new T.ConeGeometry(0.045, 0.18 + r() * 0.09, 5),
        dark,
        Math.sin(a) * 0.2 * w,
        1.74 * h,
        Math.cos(a) * 0.1 - 0.02,
      ),
      'head',
    ).rotation.z = -a * 0.18;
  }
  if ((opts?.ears ?? 0) > 0.65)
    part(
      mesh(g, new T.BoxGeometry(0.32, 0.35, 0.12), light, 0, 1.02, -0.2),
      'spine',
    );
  return g;
}
function standaloneTree(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group(),
    h = 2.3 * (opts?.height ?? 1),
    w = opts?.width ?? 1;
  limb(
    g,
    new T.Vector3(0, 0, 0),
    new T.Vector3((r() - 0.5) * 0.18, h, 0),
    0.2 * w,
    '#796b53',
  );
  const branches = Math.max(2, opts?.horns ?? 5);
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + r() * 0.4,
      y = h * (0.45 + r() * 0.38),
      end = new T.Vector3(
        Math.cos(a) * (0.55 + r() * 0.55) * w,
        y + 0.25 + r() * 0.35,
        Math.sin(a) * (0.55 + r() * 0.55) * w,
      );
    limb(g, new T.Vector3(0, y, 0), end, 0.09 * w, '#796b53');
    ball(
      g,
      i % 2 ? '#78906d' : (opts?.color ?? '#596c50'),
      end.x,
      end.y,
      end.z,
      0.48 * w,
      0.55,
      0.48 * w,
    );
  }
  ball(g, opts?.color ?? '#596c50', 0, h, 0, 0.85 * w, 0.75, 0.75 * w);
  return g;
}
function standaloneRock(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group(),
    geo = new T.IcosahedronGeometry(1, 1),
    p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const n = 0.78 + r() * 0.3 + (opts?.roughness ?? 0.2) * Math.sin(i * 4.7);
    p.setXYZ(i, p.getX(i) * n, p.getY(i) * n, p.getZ(i) * n);
  }
  geo.computeVertexNormals();
  mesh(
    g,
    geo,
    opts?.color ?? '#68706b',
    0,
    0.65,
    0,
    opts?.width ?? 1,
    (opts?.height ?? 1) * 0.72,
    opts?.ears ?? 1,
  );
  return g;
}
function standaloneMushroom(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group(),
    h = 1.25 * (opts?.height ?? 1),
    w = opts?.width ?? 1;
  mesh(
    g,
    new T.CylinderGeometry(0.17 * w, 0.28 * w, h, 7),
    '#d8d1ae',
    0,
    h / 2,
    0,
  );
  const cap = mesh(
    g,
    new T.SphereGeometry(0.75 * w, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2),
    opts?.color ?? '#9d7d7d',
    0,
    h,
    0,
    1,
    0.55,
    1,
  );
  cap.rotation.y = r();
  for (let i = 0; i < (opts?.teeth ?? 6); i++) {
    const a = r() * Math.PI * 2,
      rad = 0.2 + r() * 0.42;
    ball(
      g,
      '#e6dabd',
      Math.cos(a) * rad * w,
      h + 0.28 + r() * 0.2,
      Math.sin(a) * rad * w,
      0.06,
      0.025,
      0.06,
    );
  }
  return g;
}
function standaloneHut(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group(),
    w = opts?.width ?? 1,
    h = opts?.height ?? 1;
  mesh(
    g,
    new T.CylinderGeometry(0.72 * w, 0.86 * w, 1.1 * h, 7),
    '#b4ae8e',
    0,
    0.55 * h,
    0,
  );
  const roof = mesh(
    g,
    new T.ConeGeometry(1.18 * w, 0.9 * h, 7),
    opts?.color ?? '#7c9c94',
    0,
    1.48 * h,
    0,
  );
  roof.rotation.y = r();
  mesh(
    g,
    new T.BoxGeometry(0.32 * w, 0.7 * h, 0.06),
    '#373b30',
    0,
    0.37 * h,
    0.78 * w,
  );
  mesh(
    g,
    new T.BoxGeometry(0.18, 0.2, 0.04),
    '#e2cc86',
    0.4 * w,
    0.72 * h,
    0.7 * w,
  );
  return g;
}
function kitbash(seed: number, opts?: Partial<Recipe>) {
  const r = random(seed),
    g = new T.Group(),
    w = opts?.width ?? 1,
    h = opts?.height ?? 1,
    d = opts?.ears ?? 1,
    color = opts?.color ?? '#68798b',
    accent = new T.Color(color).lerp(new T.Color('#e1d39e'), 0.35);
  const core =
    r() > 0.5 ? new T.BoxGeometry(1, 1, 1) : new T.IcosahedronGeometry(0.7, 1);
  mesh(g, core, color, 0, 0.8 * h, 0, w, 0.65 * h, 0.7 * d);
  const modules = Math.max(1, opts?.horns ?? 4);
  for (let i = 0; i < modules; i++) {
    const side = i % 2 ? -1 : 1,
      row = Math.floor(i / 2),
      y = 0.35 + (row % 3) * 0.45 * h,
      x = side * (0.65 + 0.12 * (row % 2)) * w;
    mesh(
      g,
      row % 2
        ? new T.CylinderGeometry(0.16, 0.22, 0.48, 6)
        : new T.BoxGeometry(0.32, 0.38, 0.42),
      i % 3 ? accent : color,
      x,
      y,
      0,
      0.8,
      0.8,
      0.8,
    );
  }
  for (const side of [-1, 1])
    limb(
      g,
      new T.Vector3(side * 0.45 * w, 0.35, 0),
      new T.Vector3(side * 0.7 * w, 0.02, side * 0.12),
      0.07,
      accent,
    );
  for (let i = 0; i < (opts?.teeth ?? 5); i++) {
    const a = (i / Math.max(1, opts?.teeth ?? 5)) * Math.PI * 2;
    mesh(
      g,
      new T.ConeGeometry(0.06, 0.2 + r() * 0.2, 5),
      accent,
      Math.cos(a) * 0.42 * w,
      1.25 * h,
      Math.sin(a) * 0.38 * d,
    ).rotation.z = (r() - 0.5) * 0.5;
  }
  return g;
}
export function prop(seed: number, opts: Partial<Recipe>) {
  switch (opts.archetype) {
    case 'kitbash':
      return kitbash(seed, opts);
    case 'rock':
      return standaloneRock(seed, opts);
    case 'mushroom':
      return standaloneMushroom(seed, opts);
    case 'hut':
      return standaloneHut(seed, opts);
    default:
      return standaloneTree(seed, opts);
  }
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
