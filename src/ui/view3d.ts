import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { EngineTruck, PlacedBox, PlanResult } from '../engine';
import { t } from '../i18n/id';
import { fmt } from './dom';
import { skuColor, tierColor } from './colors';

export type ColorMode = 'sku' | 'tier' | 'risk';

/** Colour for a carton in the stability view, from its risk flags (1 tip, 2 slide, 4 overhang). */
export function riskColor(flags: number): string {
  if (flags & 1) return '#d64545';
  if (flags & 4) return '#8a4fd1';
  if (flags & 2) return '#e3a12f';
  return '#b9c3cc';
}

/**
 * three.js scene of the truck cargo space. Engine axes map to three.js as
 * x (length) -> x, y (width) -> z, z (height) -> y. One unit = 1 cm.
 */
export class TruckView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  private controls: OrbitControls;
  private truckGroup = new THREE.Group();
  /** KABIN / PINTU and the length, width and height of the cargo space; fixed to the truck, outside the load. */
  private labelGroup = new THREE.Group();
  private cargoGroup = new THREE.Group();
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private plan: PlanResult | null = null;
  private truck: EngineTruck | null = null;
  private sizes = true;
  private needsRender = true;
  private mesh: THREE.InstancedMesh | null = null;
  private visible: PlacedBox[] = [];
  private lastArgs: Parameters<TruckView['setPlan']> | null = null;
  private picked: PlacedBox | null = null;
  private raycaster = new THREE.Raycaster();
  /** Called when a carton is clicked (null when the click hits empty space). */
  onPick: ((box: PlacedBox | null) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-600, 1200, 900);
    this.scene.add(sun);
    this.scene.add(this.truckGroup, this.labelGroup, this.cargoGroup);

    // A click (not a drag) selects the carton under the pointer.
    let down: { x: number; y: number } | null = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      down = null;
      this.pickAt(e.clientX, e.clientY);
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
    const loop = () => {
      this.frame = requestAnimationFrame(loop);
      this.controls.update();
      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
    };
    loop();
  }

  static supported(): boolean {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch {
      return false;
    }
  }

  private resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** `sizes` false leaves out the size lines, for the stand-in truck shown before one is chosen. */
  setTruck(truck: EngineTruck | null, reframe = true, sizes = true) {
    this.truck = truck;
    this.sizes = sizes;
    clear(this.truckGroup);
    clear(this.labelGroup);
    if (!truck || !truck.length) {
      this.needsRender = true;
      return;
    }
    const { length: L, width: W, height: H } = truck;
    const isDark = document.documentElement.dataset.theme === 'dark';
    const lineColor = isDark ? 0x9fb0bf : 0x3a4855;
    const bodyColor = isDark ? 0x56636f : 0x8c96a0;
    const add = (obj: THREE.Object3D, x: number, y: number, z: number) => (obj.position.set(x, y, z), this.truckGroup.add(obj), obj);
    const mat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(L, W), mat(isDark ? 0x26313b : 0xc9d1d8, { side: THREE.DoubleSide }));
    floor.rotation.x = -Math.PI / 2;
    add(floor, L / 2, 0, W / 2);
    add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)), new THREE.LineBasicMaterial({ color: lineColor })), L / 2, H / 2, W / 2);

    // Truck head in front of x = 0: cab body, a dark windscreen facing forward, bumper and wheels.
    const cabL = Math.min(190, Math.max(90, L * 0.2));
    const cabH = Math.min(H * 0.92, 230);
    const cabX = -cabL / 2 - 25;
    add(new THREE.Mesh(new THREE.BoxGeometry(cabL, cabH, W * 0.96), mat(isDark ? 0x5b82b8 : 0x3f6fae)), cabX, cabH / 2, W / 2);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.8, cabH * 0.38), mat(0x1c2733, { roughness: 0.2, side: THREE.DoubleSide }));
    glass.rotation.y = -Math.PI / 2;
    add(glass, cabX - cabL / 2 - 0.5, cabH * 0.7, W / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(14, 22, W), mat(0x2a3138)), cabX - cabL / 2 - 4, 12, W / 2);
    // Chassis under the cargo floor joins the head to the box, so they read as one truck.
    add(new THREE.Mesh(new THREE.BoxGeometry(L + cabL + 25, 14, W * 0.5), mat(0x2a3138)), (L - cabL - 25) / 2, -9, W / 2);
    const r = Math.min(48, Math.max(30, H * 0.18));
    const wheel = () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 26, 24), mat(0x1f2328, { roughness: 0.9 }));
      m.rotation.x = Math.PI / 2;
      return m;
    };
    const axles = [cabX, ...(L > 600 ? [L - r * 3.4, L - r * 1.2] : [L - r * 1.4])];
    for (const x of axles) for (const z of [W * 0.12, W * 0.88]) add(wheel(), x, -r * 0.55, z);

    // Rear doors, swung open against the sides: the open end is the door.
    for (const [hinge, angle] of [
      [0, (10 * Math.PI) / 180],
      [W, (170 * Math.PI) / 180],
    ] as const) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(W / 2, H), mat(bodyColor, { transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
      const pivot = new THREE.Group();
      leaf.position.set(hinge === 0 ? W / 4 : -W / 4, 0, 0);
      pivot.add(leaf);
      pivot.rotation.y = angle;
      add(pivot, L, H / 2, hinge);
    }

    this.drawLabels();
    if (reframe) this.frameCamera();
    this.needsRender = true;
  }

  /** Shows or hides the cab, door and size labels. */
  setLabels(on: boolean) {
    this.labelGroup.visible = on;
    this.needsRender = true;
  }

  private drawLabels() {
    if (!this.truck) return;
    const { length: L, width: W, height: H } = this.truck;
    const isDark = document.documentElement.dataset.theme === 'dark';
    const ink = isDark ? '#dbe4ec' : '#24313d';
    const color = isDark ? 0xa9b8c6 : 0x4b5866;
    const size = Math.min(34, Math.max(16, Math.max(L, W * 2) * 0.03));
    const off = size * 1.2;
    const line = (pts: [number, number, number][]) =>
      this.labelGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(...p))), new THREE.LineBasicMaterial({ color })));
    const label = (text: string, x: number, y: number, z: number, strong = false) => {
      const sprite = textSprite(text, strong ? '#ffffff' : ink, strong ? '#2f6db5' : null, size * (strong ? 1.15 : 1));
      sprite.position.set(x, y, z);
      this.labelGroup.add(sprite);
    };
    const tick = size * 0.3;
    const cabL = Math.min(190, Math.max(90, L * 0.2));
    label(t.cab, -cabL / 2 - 25, Math.min(H * 0.92, 230) + size * 1.1, W / 2, true);
    label(t.door, L + off, H + size * 1.1, W / 2, true);
    if (!this.sizes) return;
    // Height at the door corner on the near side, width across the door, length along the near side.
    line([[L + off, 0, W + off], [L + off, H, W + off]]);
    line([[L + off - tick, 0, W + off], [L + off + tick, 0, W + off]]);
    line([[L + off - tick, H, W + off], [L + off + tick, H, W + off]]);
    label(t.dimHeight(fmt.int(H)), L + off + size * 2.4, H / 2, W + off);
    line([[L + off, 0, 0], [L + off, 0, W]]);
    line([[L + off - tick, 0, 0], [L + off + tick, 0, 0]]);
    line([[L + off - tick, 0, W], [L + off + tick, 0, W]]);
    label(t.dimWidth(fmt.int(W)), L + off + size * 2.4, size * 0.6, W / 2);
    line([[0, 0, W + off], [L, 0, W + off]]);
    label(t.dimLength(fmt.int(L)), L / 2, size * 0.6, W + off + size * 0.8);
  }

  frameCamera() {
    if (!this.truck) return;
    const { length: L, width: W, height: H } = this.truck;
    // The view takes in the cab in front of the box as well as the door labels behind it.
    const cabL = Math.min(190, Math.max(90, L * 0.2)) + 25;
    // Fit a sphere around cab, box and labels into the narrower of the two view angles.
    const cx = (L - cabL) / 2;
    const radius = Math.hypot(L + cabL + 80, H + 60, W + 80) / 2;
    const vFov = (this.camera.fov * Math.PI) / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.02;
    const dir = new THREE.Vector3(0.55, 0.62, 0.75).normalize();
    this.controls.target.set(cx, H / 3, W / 2);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    this.controls.update();
    this.needsRender = true;
  }

  /** Draws the plan; `upToTier` hides tiers after it (0 = all), `highlightTier` dims the others. */
  setPlan(plan: PlanResult | null, mode: ColorMode, skuOrder: number[], upToTier = 0, highlightTier = 0) {
    this.lastArgs = [plan, mode, skuOrder, upToTier, highlightTier];
    if (plan !== this.plan) this.picked = null;
    this.plan = plan;
    clear(this.cargoGroup);
    this.mesh = null;
    this.visible = [];
    if (!plan || !plan.boxes.length) {
      this.needsRender = true;
      return;
    }
    const visible = upToTier > 0 ? plan.boxes.filter((b) => b.tier <= upToTier) : plan.boxes;
    this.visible = visible;
    const geom = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 });
    const mesh = new THREE.InstancedMesh(geom, material, visible.length);
    const m = new THREE.Matrix4();
    const color = new THREE.Color();
    const gap = 0.6; // cm, so neighbouring cartons stay distinguishable
    const risk = new Map<PlacedBox, number>();
    plan.stability?.flagged.forEach((idx, k) => risk.set(plan.boxes[idx], plan.stability!.flags[k]));
    const edgePositions: number[] = [];

    visible.forEach((b, i) => {
      m.makeScale(b.dx - gap, b.dz - gap, b.dy - gap);
      m.setPosition(b.x + b.dx / 2, b.z + b.dz / 2, b.y + b.dy / 2);
      mesh.setMatrixAt(i, m);
      const base = mode === 'sku' ? skuColor(skuOrder.indexOf(b.skuId)) : mode === 'tier' ? tierColor(b.tier) : riskColor(risk.get(b) ?? 0);
      color.set(base);
      if (highlightTier > 0 && b.tier !== highlightTier) color.lerp(new THREE.Color(0xdde3e8), 0.75);
      if (b === this.picked) color.lerp(new THREE.Color(0xffffff), 0.55);
      mesh.setColorAt(i, color);
      pushBoxEdges(edgePositions, b.x, b.z, b.y, b.dx, b.dz, b.dy);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.cargoGroup.add(mesh);
    this.mesh = mesh;

    const edges = new THREE.BufferGeometry();
    edges.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    this.cargoGroup.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x1b2630, transparent: true, opacity: 0.35 })));
    this.needsRender = true;
  }

  private pickAt(clientX: number, clientY: number) {
    if (!this.mesh) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh)[0];
    const box = hit?.instanceId != null ? this.visible[hit.instanceId] ?? null : null;
    this.picked = box === this.picked ? null : box;
    if (this.lastArgs) this.setPlan(...this.lastArgs);
    this.onPick?.(this.picked);
  }

  /** Redraws with the current light or dark colours. */
  refreshTheme() {
    this.setTruck(this.truck, false);
    if (this.lastArgs) this.setPlan(...this.lastArgs);
  }

  get currentPlan() {
    return this.plan;
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }
}

function clear(group: THREE.Object3D) {
  for (const child of [...group.children]) {
    group.remove(child);
    clear(child);
    const obj = child as THREE.Mesh;
    obj.geometry?.dispose();
    const mat = obj.material as (THREE.Material & { map?: THREE.Texture | null }) | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else {
      mat?.map?.dispose();
      mat?.dispose();
    }
  }
}

/** A text label that always faces the camera, `height` cm tall, on a rounded tag when `bg` is set. */
function textSprite(text: string, ink: string, bg: string | null, height: number): THREE.Sprite {
  const px = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `700 ${px}px system-ui, sans-serif`;
  ctx.font = font;
  const pad = px * 0.35;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = Math.ceil(px * 1.4);
  ctx.font = font;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, canvas.width, canvas.height, px * 0.3);
    ctx.fill();
  }
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, canvas.height / 2 + px * 0.04);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set((height * canvas.width) / canvas.height, height, 1);
  return sprite;
}

function pushBoxEdges(out: number[], x: number, y: number, z: number, dx: number, dy: number, dz: number) {
  const X = x + dx;
  const Y = y + dy;
  const Z = z + dz;
  const c = [
    [x, y, z], [X, y, z], [X, Y, z], [x, Y, z],
    [x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z],
  ];
  const e = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  for (const i of e) out.push(c[i][0], c[i][1], c[i][2]);
}
