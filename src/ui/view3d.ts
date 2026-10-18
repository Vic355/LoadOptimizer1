import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { EngineTruck, PlacedBox, PlanResult } from '../engine';
import { skuColor, tierColor } from './colors';

export type ColorMode = 'sku' | 'tier';

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
  private cargoGroup = new THREE.Group();
  private resizeObserver: ResizeObserver;
  private frame = 0;
  private plan: PlanResult | null = null;
  private truck: EngineTruck | null = null;
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
    this.scene.add(this.truckGroup, this.cargoGroup);

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

  setTruck(truck: EngineTruck | null, reframe = true) {
    this.truck = truck;
    clear(this.truckGroup);
    if (!truck || !truck.length) {
      this.needsRender = true;
      return;
    }
    const { length: L, width: W, height: H } = truck;
    const isDark = document.documentElement.dataset.theme === 'dark';
    const lineColor = isDark ? 0x9fb0bf : 0x3a4855;

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(L, W),
      new THREE.MeshStandardMaterial({ color: isDark ? 0x26313b : 0xc9d1d8, side: THREE.DoubleSide }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(L / 2, 0, W / 2);
    this.truckGroup.add(floor);

    const shell = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)),
      new THREE.LineBasicMaterial({ color: lineColor }),
    );
    shell.position.set(L / 2, H / 2, W / 2);
    this.truckGroup.add(shell);

    // Cab marker in front of x = 0, so the loading direction is obvious.
    const cabH = Math.min(H, 220);
    const cab = new THREE.Mesh(
      new THREE.BoxGeometry(Math.min(180, L * 0.18), cabH, W),
      new THREE.MeshStandardMaterial({ color: isDark ? 0x56636f : 0x8c96a0, transparent: true, opacity: 0.55 }),
    );
    cab.position.set(-Math.min(180, L * 0.18) / 2 - 20, cabH / 2, W / 2);
    this.truckGroup.add(cab);

    if (reframe) this.frameCamera();
    this.needsRender = true;
  }

  frameCamera() {
    if (!this.truck) return;
    const { length: L, width: W, height: H } = this.truck;
    const span = Math.max(L, W * 2, H * 2);
    this.camera.position.set(L * 1.05, H + span * 0.55, W + span * 0.75);
    this.controls.target.set(L / 2, H / 3, W / 2);
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
    const edgePositions: number[] = [];

    visible.forEach((b, i) => {
      m.makeScale(b.dx - gap, b.dz - gap, b.dy - gap);
      m.setPosition(b.x + b.dx / 2, b.z + b.dz / 2, b.y + b.dy / 2);
      mesh.setMatrixAt(i, m);
      const base = mode === 'sku' ? skuColor(skuOrder.indexOf(b.skuId)) : tierColor(b.tier);
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

function clear(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    const obj = child as THREE.Mesh;
    obj.geometry?.dispose();
    const mat = obj.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  }
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
