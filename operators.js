// The lobby and the game use the same three operator rigs. Front is -Z, feet are at Y=0.
(() => {
  'use strict';
  const catalog = [
    { id: 'scout', cloth: 0x68735b, vest: 0x444f43, trim: 0xb2a67a },
    { id: 'diver', cloth: 0x315c64, vest: 0x23424b, trim: 0xc58b45 },
    { id: 'bulwark', cloth: 0x4e535a, vest: 0x69747c, trim: 0xcd7848 },
  ];
  const modelId = id => catalog.some(model => model.id === id) ? id : catalog[0].id;
  function displayName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16).replace(/[\uD800-\uDBFF]$/u, '').trim();
  }

  // An elliptical cross-section at each height gives boots, cloth and shells their own contours.
  // Rings are [height, half width, half depth, forward/back offset].
  function loft(T, rings, sides = 20, exponent = 0.85) {
    const positions = [], indices = [];
    for (const [height, width, depth, shift = 0] of rings) {
      for (let j = 0; j < sides; j++) {
        const angle = j * 2 * Math.PI / sides;
        const shape = v => Math.sign(v) * Math.pow(Math.abs(v), exponent);
        positions.push(width * shape(Math.cos(angle)), height, shift + depth * shape(Math.sin(angle)));
      }
    }
    for (let row = 0; row < rings.length - 1; row++) {
      for (let j = 0; j < sides; j++) {
        const a = row * sides + j, b = row * sides + (j + 1) % sides;
        indices.push(a, a + sides, b, b, a + sides, b + sides);
      }
    }
    const top = (rings.length - 1) * sides;
    for (let j = 1; j < sides - 1; j++) indices.push(0, j, j + 1, top, top + j + 1, top + j);
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  function makeModel(T, requestedId, insigniaColor) {
    const id = modelId(requestedId);
    const { cloth, vest, trim } = catalog.find(model => model.id === id);
    const heavy = id === 'bulwark', diver = id === 'diver';
    const rubber = 0x272c30, strap = 0x373a36, seam = 0x888673, steel = 0x48535a;
    const accent = insigniaColor ?? trim;
    const root = new T.Group();
    root.name = id;
    const sections = new Map();
    const materials = {
      fabric: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.91 }),
      hardware: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0.42 }),
      glass: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.19, metalness: 0.37 }),
    };
    function joint(parent, name, x, y, z) {
      const group = new T.Group();
      group.name = name;
      group.position.set(x, y, z);
      parent.add(group);
      return group;
    }
    // Bake rigid details by joint and finish. Equipment does not cost a draw call per buckle.
    function add(parent, geo, color, finish = 'fabric', at = [0, 0, 0], rotation, scale = [1, 1, 1]) {
      const q = rotation?.isQuaternion ? rotation : new T.Quaternion().setFromEuler(new T.Euler(...(rotation || [0, 0, 0])));
      geo.applyMatrix4(new T.Matrix4().compose(new T.Vector3(...at), q, new T.Vector3(...scale)));
      if (!sections.has(parent)) sections.set(parent, new Map());
      const finishes = sections.get(parent);
      if (!finishes.has(finish)) finishes.set(finish, { pos: [], normal: [], color: [], index: [] });
      const batch = finishes.get(finish), base = batch.pos.length / 3;
      const pos = geo.getAttribute('position'), normal = geo.getAttribute('normal'), rgb = new T.Color(color);
      for (let i = 0; i < pos.count; i++) {
        batch.pos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
        batch.normal.push(normal.getX(i), normal.getY(i), normal.getZ(i));
        batch.color.push(rgb.r, rgb.g, rgb.b);
      }
      const ix = geo.getIndex();
      for (let i = 0; i < (ix ? ix.count : pos.count); i++) batch.index.push(base + (ix ? ix.getX(i) : i));
      geo.dispose();
    }
    function shell(parent, rings, at, color, finish = 'fabric', sides = 20, exponent = 0.85) {
      add(parent, loft(T, rings, sides, exponent), color, finish, at);
    }
    function oval(parent, at, size, color, finish = 'fabric', rotation) {
      add(parent, new T.SphereGeometry(1, 16, 10), color, finish, at, rotation, size);
    }
    function rod(parent, from, to, r1, r2, color, finish = 'hardware', facets = 12) {
      const start = new T.Vector3(...from), end = new T.Vector3(...to), dir = end.clone().sub(start);
      const length = dir.length(), center = start.addScaledVector(dir, 0.5);
      const q = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 1, 0), dir.normalize());
      add(parent, new T.CylinderGeometry(r2, r1, length, facets), color, finish, center.toArray(), q);
    }
    function tube(parent, points, radius, color, finish = 'fabric') {
      const path = new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p)));
      add(parent, new T.TubeGeometry(path, 16, radius, 7, false), color, finish);
    }
    function sleeve(parent, from, to, startRadius, endRadius, color) {
      const a = new T.Vector3(...from), b = new T.Vector3(...to), axis = b.sub(a);
      const length = axis.length();
      const rings = [[0,.86],[.1,1.04],[.29,1.10],[.56,.98],[.63,1.05],[.69,.94],[.79,1.03],[.94,.94],[1,.89]]
        .map(([t, fold]) => {
          const radius = (startRadius * (1 - t) + endRadius * t) * fold;
          return [t * length, radius, radius * .91];
        });
      add(parent, loft(T, rings, 14), color, 'fabric', from,
        new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0), axis.normalize()));
    }
    function plate(parent, contour, thickness, at, color, finish = 'hardware', rotation) {
      const shape = new T.Shape(contour.map(([x, y]) => new T.Vector2(x, y)));
      const bevel = Math.min(0.009, thickness * 0.25);
      const geo = new T.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSegments: 1, bevelSize: bevel, bevelThickness: bevel });
      add(parent, geo, color, finish, at, rotation);
    }
    function panel(parent, x, y, z, width, height, depth, color, finish = 'hardware') {
      const w = width / 2, h = height / 2, cut = Math.min(w, h) * 0.32;
      plate(parent, [[-w + cut, -h], [w - cut, -h], [w, -h + cut], [w, h - cut],
        [w - cut, h], [-w + cut, h], [-w, h - cut], [-w, -h + cut]], depth, [x, y, z], color, finish);
    }

    const body = joint(root, 'body', 0, 0, 0);
    const upper = joint(body, 'torso', 0, 0.88, 0);
    const arms = joint(upper, 'aim', 0, 0.52, 0);
    const legs = [], knees = [];
    const shoulder = heavy ? 0.253 : diver ? 0.217 : 0.209;
    const hipWidth = heavy ? 0.113 : 0.103;
    for (const side of [-1, 1]) {
      const hip = joint(body, 'hip-' + side, side * hipWidth, 0.89, side * 0.026);
      hip.rotation.z = side * 0.045;
      const knee = joint(hip, 'knee-' + side, 0, -0.435, -0.008);
      legs.push(hip); knees.push(knee);
      shell(hip, [[-0.43, .066, .073], [-.408, .077, .083], [-.389, .071, .079], [-.37, .077, .087],
        [-.29, .083, .094], [-.22, .096, .105], [-.198, .091, .098], [-.17, .099, .106],
        [-.08, .108, .117], [-.025, .104, .113], [.025, .084, .081]], [0, 0, 0], cloth);
      shell(knee, [[-.38, .06, .066], [-.29, .065, .076, .008], [-.18, .082, .093, .014],
        [-.084, .078, .083], [-.01, .071, .076], [.035, .067, .075]], [0, 0, 0], cloth);
      oval(knee, [0, -.005, -.037], [.073, .085, .064], diver ? rubber : vest);
      if (!diver) {
        panel(knee, 0, -.018, -.097, heavy ? .139 : .105, heavy ? .18 : .102, .027, heavy ? steel : 0x50584a);
        panel(knee, 0, -.016, -.109, heavy ? .10 : .078, heavy ? .12 : .066, .014, vest);
        panel(hip, side * .087, -.21, -.061, .063, .136, .069, vest, 'fabric');
        panel(hip, side * .087, -.162, -.071, .071, .043, .066, strap, 'fabric');
      }
      shell(hip, [[-.363,.082,.092],[-.34,.086,.095]], [0,0,0], diver ? trim : strap);
      shell(knee, [[-.105,.08,.088],[-.083,.081,.089]], [0,0,0], strap);
      shell(knee, [[-.332,.069,.079],[-.295,.075,.083],[-.238,.08,.093],[-.161,.086,.099],
        [-.133,.083,.095]], [0,0,0], diver ? 0x263c40 : rubber, 'fabric', 14);
      panel(knee, 0, -.24, -.088, heavy ? .093 : .052, .14, .016, heavy ? steel : vest);
      const boot = [[0, .071, .131, -.045], [.025, .082, .148, -.048],
        [.064, .084, .143, -.047], [.105, .076, .105, -.015], [.155, .067, .072, .009], [.20, .066, .065, .007]];
      shell(knee, boot, [0, -.455, 0], rubber, 'fabric', 16, .72);
      shell(knee, [[0, .074, .142, -.045], [.02, .083, .15, -.048], [.032, .083, .149, -.048]],
        [0, -.455, 0], 0x202427, 'hardware', 16, .7);
      for (let i = 0; i < 3; i++) {
        const y = -.351 - i * .013, z = -.113 - i * .019;
        rod(knee, [-.044,y,z], [.042,y+.006,z-.006], .005,.005, diver ? trim : seam, 'fabric', 6);
      }
    }
    shell(upper, [[-.066, .135, .103], [-.015, .165, .116], [.12, .149, .107], [.23, .156, .113],
      [.38, shoulder * .91, .142, .005], [.48, shoulder, .127, .011], [.55, shoulder * .82, .11], [.585, .079, .077]],
    [0, 0, 0], cloth);
    shell(upper, [[.026, .163, .118], [.045, .169, .122], [.095, .168, .12], [.105, .156, .112]], [0, 0, 0], strap);
    panel(upper, 0, .067, -.129, .053, .044, .014, trim);
    for (const side of [-1,1]) {
      shell(upper, [[-.048,.035,.035],[-.033,.048,.041],[.061,.049,.043],[.086,.042,.04]],
        [side*.147,0,-.064], vest, 'fabric', 12,.64);
      panel(upper,side*.148,.053,-.11,.074,.034,.022,strap,'fabric');
    }
    shell(upper, [[.145, .151, .116], [.174, .17, .131], [.33, shoulder * .94, .153],
      [.464, shoulder * .98, .143], [.507, shoulder * .83, .113]], [0, 0, 0], vest, diver ? 'fabric' : 'hardware', 16, .8);
    for (const side of [-1, 1]) {
      tube(upper, [[side * .103, .17, -.108], [side * .13, .36, -.143],
        [side * .154, .52, -.093], [side * .137, .552, .014], [side * .12, .44, .13]], diver ? .019 : .023, strap);
      panel(upper, side * .13, .425, -.147, .042, .048, .012, trim);
    }

    for (const side of [-1, 1]) {
      const shoulderPos = [side * shoulder, -.003, .005];
      const elbow = side < 0 ? [-.27, -.219, -.123] : [.318, -.198, .047];
      const wrist = side < 0 ? [.03, -.10, -.397] : [.122, -.123, -.184];
      oval(arms, shoulderPos, [heavy ? .101 : .088, .099, .098], cloth);
      sleeve(arms, shoulderPos, elbow, .083, .063, cloth);
      oval(arms, elbow, [.066, .064, .069], rubber);
      sleeve(arms, elbow, wrist, .072, .045, diver ? cloth : vest);
      const cuff = elbow.map((v,j) => v*.22+wrist[j]*.78);
      const cuffEnd = elbow.map((v,j) => v*.09+wrist[j]*.91);
      rod(arms,cuff,cuffEnd,.056,.05,diver ? trim : rubber,'fabric',14);
      oval(arms, wrist, [.056, .051, .066], rubber);
      const hand = side < 0 ? [.099, -.076, -.413] : [.13, -.097, -.194];
      rod(arms, wrist, hand, .044, .041, rubber, 'fabric');
      oval(arms, hand, [.052, .046, .054], 0x363b38);
      for(let finger=0;finger<3;finger++) oval(arms,[hand[0]+side*.035,hand[1]-.024,hand[2]+finger*.018-.016],[.023,.027,.01],rubber);
      if (heavy) {
        shell(arms,[[-.078,.094,.106],[-.043,.133,.143],[.02,.133,.149],[.068,.11,.121],[.088,.063,.086]],
          [side*.253,.014,.008], vest,'hardware',12,.75);
        panel(arms,side*.259,.015,-.143,.10,.027,.017,trim);
      } else {
        tube(arms, [[side*.265,.042,.061],[side*.288,.002,.003],[side*.261,-.044,-.073]], .011, trim);
      }
    }
    // Receiver, stock, magazine and muzzle are on the aim joint, with both hands on the carbine.
    const gun = joint(arms, 'carbine', .135, -.045, 0);
    plate(gun, [[-.15, .034], [.06, .03], [.112, .01], [.10, -.056], [.042, -.052], [-.08, -.01], [-.15, -.016]],
      .045, [.023, 0, 0], rubber, 'fabric', [0, -Math.PI / 2, 0]);
    panel(gun, 0, 0, -.315, .068, .084, .215, 0x394149);
    rod(gun,[0,-.026,-.159],[0,-.119,-.127],.023,.022,rubber,'fabric',10);
    plate(gun, [[-.043, 0], [.038, 0], [.055, -.11], [.034, -.16], [-.027, -.144], [-.02, -.067]],
      .035, [-.018, -.026, -.247], 0x414b4a, 'hardware', [0, Math.PI / 2, 0]);
    rod(gun, [0, .002, -.31], [0, .002, -.565], .045, .036, rubber);
    for (let i = 0; i < 5; i++) {
      const z = -.334 - i * .041;
      rod(gun, [0, .002, z], [0, .002, z - .012], .046, .044, steel);
    }
    rod(gun, [0, .004, -.55], [0, .004, -.696], .019, .015, steel);
    rod(gun, [0, .004, -.686], [0, .004, -.755], .024, .024, rubber);
    rod(gun, [0,.004,-.754], [0,.004,-.757], .015,.015, 0x10181a);
    rod(gun, [0, .074, -.202], [0, .074, -.257], .027, .027, rubber);
    oval(gun, [0, .074, -.258], [.018, .018, .004], 0x729f9d, 'glass');
    panel(gun, 0, .045, -.23, .029, .045, .044, steel);
    const muzzle = joint(gun, 'muzzle', 0, .004, -.755);

    if (id === 'scout') {
      // A peaked fabric hood surrounds a recessed balaclava and a pair of amber field lenses.
      shell(upper, [[.52, .097, .1], [.56, .115, .119], [.59, .107, .121], [.617, .089, .098]],
        [0, 0, 0], 0x505746);
      shell(upper, [[.576, .096, .098, .012], [.646, .122, .133, .006], [.758, .139, .146, .012],
        [.835, .134, .152, .005], [.896, .102, .125, .016], [.927, .032, .052, .028]], [0, 0, 0], cloth);
      oval(upper, [0, .737, -.101], [.108, .135, .074], rubber);
      const goggleShape=[[-.101,.014],[-.087,.035],[.084,.035],[.101,.012],[.083,-.024],[.025,-.031],[0,-.013],[-.024,-.031],[-.081,-.024]];
      plate(upper,goggleShape,.023,[0,.768,-.17],0x242d30);
      add(upper,new T.SphereGeometry(1,20,10),0x85653c,'glass',[0,.778,-.176],null,[.094,.025,.012]);
      tube(upper,[[-.098,.795,-.157],[0,.807,-.183],[.096,.795,-.16]],.006,trim);
      tube(upper,[[-.083,.64,-.103],[-.118,.72,-.117],[-.113,.81,-.12],[-.074,.849,-.13],[0,.857,-.143],
        [.074,.849,-.13],[.113,.81,-.12],[.118,.72,-.117],[.083,.64,-.103]],.012,0x535c4b);
      oval(upper, [0,.69,-.15], [.091,.053,.039], 0x515748);
      for(let i=0;i<3;i++)tube(upper,[[-.063,.704-i*.015,-.172],[0,.692-i*.014,-.19],[.064,.705-i*.015,-.171]],.004,strap);
      shell(upper, [[.585, .098, .085], [.606, .119, .1], [.629, .108, .096]], [0, 0, -.018], 0x70755e);
      for (const side of [-1, 0, 1]) {
        panel(upper,side*.091,.226,-.159,.077,.121,.039,0x515b47,'fabric');
        panel(upper,side*.091,.266,-.166,.083,.058,.027,cloth,'fabric');
        panel(upper,side*.091,.243,-.178,.013,.036,.017,strap);
      }
      tube(upper,[[-.19,.516,-.04],[-.116,.542,-.089],[.012,.517,-.152],[.135,.469,-.119],[.2,.421,-.022]],.025,0x737a61);
      panel(upper, -.112, .372, -.155, .071, .09, .029, rubber);
      rod(upper, [-.119, .408, -.126], [-.151, .658, -.098], .008, .004, steel);
      oval(upper, [0, .322, .139], [.149, .205, .099], cloth);
      rod(upper, [-.157, .455, .176], [.157, .455, .176], .051, .051, 0x797d64, 'fabric');
    } else if (diver) {
      // Sealed copper helmet, a convex porthole, external hoses and twin air cylinders.
      shell(upper, [[.511, .107, .112], [.528, .159, .139], [.57, .165, .145], [.61, .129, .122]],
        [0, 0, 0], trim, 'hardware');
      shell(upper, [[.568, .113, .112], [.602, .144, .14], [.70, .158, .16], [.814, .151, .155],
        [.878, .116, .123], [.906, .067, .081], [.915, .025, .036]], [0, 0, 0], 0x997c50, 'hardware');
      rod(upper, [0, .741, -.105], [0, .741, -.174], .123, .119, rubber);
      rod(upper, [0, .741, -.164], [0, .741, -.188], .127, .122, trim, 'hardware', 28);
      oval(upper, [0, .741, -.183], [.103, .103, .042], 0x285666, 'glass');
      for(const s of [-1,1]) tube(upper,[[s*.055,.652,-.189],[s*.055,.702,-.221],[s*.055,.778,-.223],[s*.055,.835,-.189]],.0068,trim,'hardware');
      tube(upper,[[-.108,.743,-.19],[-.048,.743,-.225],[.046,.743,-.225],[.108,.743,-.19]],.0068,trim,'hardware');
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        oval(upper, [Math.cos(a) * .114, .741 + Math.sin(a) * .114, -.188], [.008, .008, .006], 0xe1c08b, 'hardware');
      }
      for (const side of [-1, 1]) {
        rod(upper, [side * .143, .727, 0], [side * .177, .727, 0], .054, .051, trim);
        shell(upper,[[-.252,.031,.031],[-.239,.065,.065],[-.202,.081,.081],[.19,.081,.081],[.225,.064,.064],[.238,.029,.029]],
          [side*.113,.334,.19], 0xa8afa5, 'hardware');
        for (const y of [.185, .426]) rod(upper, [side*.113,y,.19],[side*.113,y+.029,.19],.083,.083,strap);
        rod(upper,[side*.113,.563,.19],[side*.113,.623,.19],.027,.023,trim);
        rod(upper,[side*.136,.617,.19],[side*.09,.617,.19],.025,.025,0xa35c3a);
        tube(upper, [[side * .143, .677, -.049], [side * .192, .58, -.094], [side * .18, .406, -.112],
          [side * .221, .351, .014], [side * .185, .467, .149], [side * .093, .602, .177]], .017, rubber);
      }
      panel(upper,0,.287,-.171,.156,.104,.032,rubber);
      oval(upper,[.032,.29,-.178],[.032,.032,.009],0xd1c5a2,'glass');
      rod(upper,[.032,.29,-.189],[.02,.306,-.19],.002,.002,0x523c30);
      for(const side of [-1,1])tube(upper,[[side*.128,.478,-.132],[side*.146,.32,-.147],[side*.116,.158,-.151]],
        .021,0x29383b);
    } else {
      // A broad ballistic collar, stepped plates, cheek guards and a single recessed visor slit.
      shell(upper, [[.477, .17, .139], [.508, .195, .145], [.554, .154, .126], [.583, .113, .108]],
        [0, 0, 0], rubber, 'hardware', 14);
      oval(upper, [0, .718, -.012], [.132, .166, .133], rubber);
      shell(upper, [[.696, .14, .148], [.742, .152, .164], [.824, .154, .158, .005],
        [.882, .129, .138, .008], [.912, .077, .095, .018], [.92, .029, .056, .023]],
      [0, 0, 0], vest, 'hardware', 16, .75);
      for(const side of [-1,1]){
        tube(upper,[[side*.065,.837,-.117],[side*.058,.896,-.064],[side*.044,.919,.012],[side*.046,.887,.089]],
          .012,steel,'hardware');
        rod(upper,[side*.137,.795,.014],[side*.162,.795,.014],.064,.056,rubber);
      }
      plate(upper,[[-.143,-.018],[-.116,.018],[.117,.018],[.142,-.018],[.089,-.034],[-.089,-.034]],
        .037,[0,.818,-.157],vest);
      plate(upper, [[-.132, .039], [-.095, .057], [.099, .057], [.134, .029], [.106, -.049],
        [.051, -.076], [-.065, -.07], [-.115, -.04]], .041, [0, .739, -.157], steel);
      plate(upper, [[-.116, .018], [.114, .019], [.095, -.009], [.035, -.014], [-.097, -.007]],
        .009, [0, .759, -.17], 0x936a3d, 'glass');
      for (const side of [-1, 1]) {
        oval(upper, [side * .114, .677, -.053], [.039, .09, .095], vest, 'hardware');
        panel(upper, side * .124, .207, -.139, .061, .137, .052, strap, 'fabric');
        rod(upper,[side*.078,.663,-.107],[side*.084,.659,-.157],.034,.039,rubber);
        for(let i=0;i<3;i++)panel(upper,side*.083,.662+(i-1)*.012,-.16,.041,.004,.005,steel);
      }
      plate(upper, [[-.173, .068], [-.112, .12], [.112, .12], [.173, .063], [.131, -.098],
        [0, -.137], [-.136, -.096]], .035, [0, .344, -.167], 0x77838a);
      for(const side of [-1,1])tube(upper,[[side*.141,.42,-.176],[side*.107,.399,-.176],[side*.058,.395,-.176]],.006,steel);
      for (let i = 0; i < 3; i++) panel(upper, 0, .181 - i * .036, -.135 + i * .006, .22 - i * .013, .033, .024, steel);
      panel(upper, 0, .355, .117, .252, .342, .126, vest);
    }
    panel(upper, .075, .376, heavy ? -.181 : -.156, .066, .023, .01, accent);

    for (const [parent, finishes] of sections) {
      for (const [finish, batch] of finishes) {
        const geo = new T.BufferGeometry();
        for (const [key, values] of [['position', batch.pos], ['normal', batch.normal], ['color', batch.color]]) {
          geo.setAttribute(key, new T.Float32BufferAttribute(values, 3));
        }
        geo.setIndex(batch.index);
        geo.computeBoundingSphere();
        const mesh = new T.Mesh(geo, materials[finish]);
        mesh.name = parent.name + '-' + finish;
        mesh.castShadow = mesh.receiveShadow = true;
        parent.add(mesh);
      }
    }
    return { root, body, upper, arms, legs, knees, muzzle, walk: 0, lie: 0, kick: 0,
      dispose() {
        root.removeFromParent();
        root.traverse(node => node.geometry?.dispose());
        for (const material of Object.values(materials)) material.dispose();
      },
    };
  }

  const api = { catalog, modelId, displayName, makeModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SaltlineOperators = api;
})();
