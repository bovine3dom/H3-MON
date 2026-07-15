/*
 * H3 cell-to-boundary compute kernel.
 *
 * Portions are adapted from the luma.gl DGGS WGSL implementation at
 * 01dd287e7bf8c2a3e65d46173a9785063266ba10. Copyright (c) 2020 vis.gl
 * contributors, used under the MIT License.
 *
 * H3 indexing, FaceIJK, overage, pentagon, and crossing-vertex algorithms and
 * tables are adapted from H3 4.4.1. Copyright 2016-2024 Uber Technologies,
 * Inc., used under the Apache License, Version 2.0.
 *
 * This file has been modified to support complete resolutions 4-8 topology,
 * fixed Web Mercator output records, validation, and explicit status values.
 * Full notices are in h3-compute-NOTICES.md.
 */

export const H3_COMPUTE_WGSL = /* wgsl */ `
const H3_MIN_RESOLUTION: u32 = 4u;
const H3_MAX_RESOLUTION: u32 = 8u;
const H3_INDEX_MAX_RESOLUTION: u32 = 15u;
const H3_MAX_BASE_CELL: u32 = 121u;
const H3_UNUSED_DIGIT: u32 = 7u;
const H3_RESULT_CAPACITY: u32 = 10u;

const H3_STATUS_SUCCESS: u32 = 0u;
const H3_STATUS_INVALID_ID: u32 = 1u;
const H3_STATUS_UNSUPPORTED_RESOLUTION: u32 = 2u;
const H3_STATUS_TOPOLOGY_OVERFLOW: u32 = 3u;
const H3_STATUS_FACE_TRANSFORM_FAILED: u32 = 4u;
const H3_STATUS_NUMERIC_FAILURE: u32 = 5u;

const H3_NO_OVERAGE: u32 = 0u;
const H3_FACE_EDGE: u32 = 1u;
const H3_NEW_FACE: u32 = 2u;
const H3_IJ: u32 = 1u;
const H3_KI: u32 = 2u;
const H3_JK: u32 = 3u;

const H3_PI: f32 = 3.141592653589793;
const H3_INV_TWO_PI: vec2<f32> = vec2<f32>(0.15915494309189535, 6.420638326565253e-9);
const H3_SINH_PI: f32 = 11.548739357257748;
const H3_AP7_ROT_COS: f32 = 0.944911182523068;
const H3_AP7_ROT_SIN: f32 = 0.32732683535398857;
const H3_SQRT3_OVER_2: f32 = 0.8660254037844386;

struct H3FaceIJK {
    face: u32,
    coord: vec3<i32>,
    valid: u32,
}

struct H3BoundaryVertex {
    face: u32,
    coord: vec3<i32>,
    resolution: u32,
    overage: u32,
    valid: u32,
}

struct H3Intersection {
    point: vec2<f32>,
    atEndpoint: u32,
    valid: u32,
}

struct H3FaceBasis {
    center: vec3<f32>,
    axisX: vec3<f32>,
    axisY: vec3<f32>,
}

struct H3ComputeResult {
    boundary: array<vec2<f32>, 10>,
    count: u32,
    status: u32,
}

@group(0) @binding(0) var<storage, read> h3Ids: array<vec2<u32>>;
@group(0) @binding(1) var<storage, read_write> h3Results: array<H3ComputeResult>;

fn h3_nan(seed: u32) -> f32 {
    return bitcast<f32>(0x7fc00000u | (seed & 0x003fffffu));
}

fn h3_empty_result(status: u32) -> H3ComputeResult {
    var result: H3ComputeResult;
    var index = 0u;
    loop {
        if (index >= H3_RESULT_CAPACITY) {
            break;
        }
        result.boundary[index] = vec2<f32>(h3_nan(index));
        index += 1u;
    }
    result.count = 0u;
    result.status = status;
    return result;
}

// IDs arrive as little-endian words: x is bits 0-31, y is bits 32-63.
fn h3_extract_bits(index: vec2<u32>, offset: u32, width: u32) -> u32 {
    let mask = (1u << width) - 1u;
    if (offset >= 32u) {
        return (index.y >> (offset - 32u)) & mask;
    }
    if (offset + width <= 32u) {
        return (index.x >> offset) & mask;
    }
    return ((index.x >> offset) | (index.y << (32u - offset))) & mask;
}

fn h3_get_resolution(index: vec2<u32>) -> u32 {
    return h3_extract_bits(index, 52u, 4u);
}

fn h3_get_base_cell(index: vec2<u32>) -> u32 {
    return h3_extract_bits(index, 45u, 7u);
}

fn h3_get_digit(index: vec2<u32>, resolution: u32) -> u32 {
    if (resolution == 0u || resolution > H3_INDEX_MAX_RESOLUTION) {
        return H3_UNUSED_DIGIT;
    }
    return h3_extract_bits(index, 3u * (H3_INDEX_MAX_RESOLUTION - resolution), 3u);
}

fn h3_is_base_cell_pentagon(baseCell: u32) -> bool {
    return baseCell == 4u || baseCell == 14u || baseCell == 24u ||
        baseCell == 38u || baseCell == 49u || baseCell == 58u ||
        baseCell == 63u || baseCell == 72u || baseCell == 83u ||
        baseCell == 97u || baseCell == 107u || baseCell == 117u;
}

fn h3_leading_nonzero_digit(index: vec2<u32>) -> u32 {
    let resolution = h3_get_resolution(index);
    var digitResolution = 1u;
    loop {
        if (digitResolution > resolution) {
            break;
        }
        let digit = h3_get_digit(index, digitResolution);
        if (digit != 0u) {
            return digit;
        }
        digitResolution += 1u;
    }
    return 0u;
}

fn h3_is_valid_cell(index: vec2<u32>) -> bool {
    // H3 cells have high byte 0_0001_000: high bit zero, cell mode one,
    // and all three reserved bits zero.
    if ((index.y >> 24u) != 0x08u) {
        return false;
    }
    let resolution = h3_get_resolution(index);
    let baseCell = h3_get_base_cell(index);
    if (baseCell > H3_MAX_BASE_CELL) {
        return false;
    }

    var digitResolution = 1u;
    loop {
        if (digitResolution > H3_INDEX_MAX_RESOLUTION) {
            break;
        }
        let digit = h3_get_digit(index, digitResolution);
        if (digitResolution <= resolution) {
            if (digit == H3_UNUSED_DIGIT) {
                return false;
            }
        } else if (digit != H3_UNUSED_DIGIT) {
            return false;
        }
        digitResolution += 1u;
    }

    return !h3_is_base_cell_pentagon(baseCell) || h3_leading_nonzero_digit(index) != 1u;
}

fn h3_is_class_iii(resolution: u32) -> bool {
    return (resolution & 1u) != 0u;
}

fn h3_rotate_digit_cw(digit: u32) -> u32 {
    switch digit {
        case 1u: { return 3u; }
        case 3u: { return 2u; }
        case 2u: { return 6u; }
        case 6u: { return 4u; }
        case 4u: { return 5u; }
        case 5u: { return 1u; }
        default: { return digit; }
    }
}

fn h3_effective_digit(index: vec2<u32>, resolution: u32, rotatePentagon: bool) -> u32 {
    let digit = h3_get_digit(index, resolution);
    return select(digit, h3_rotate_digit_cw(digit), rotatePentagon);
}

fn h3_get_base_cell_home(baseCell: u32) -> H3FaceIJK {
    let values = array<vec4<i32>, 122>(
        vec4<i32>(1, 1, 0, 0), vec4<i32>(2, 1, 1, 0), vec4<i32>(1, 0, 0, 0),
        vec4<i32>(2, 1, 0, 0), vec4<i32>(0, 2, 0, 0), vec4<i32>(1, 1, 1, 0),
        vec4<i32>(1, 0, 0, 1), vec4<i32>(2, 0, 0, 0), vec4<i32>(0, 1, 0, 0),
        vec4<i32>(2, 0, 1, 0), vec4<i32>(1, 0, 1, 0), vec4<i32>(1, 0, 1, 1),
        vec4<i32>(3, 1, 0, 0), vec4<i32>(3, 1, 1, 0), vec4<i32>(11, 2, 0, 0),
        vec4<i32>(4, 1, 0, 0), vec4<i32>(0, 0, 0, 0), vec4<i32>(6, 0, 1, 0),
        vec4<i32>(0, 0, 0, 1), vec4<i32>(2, 0, 1, 1), vec4<i32>(7, 0, 0, 1),
        vec4<i32>(2, 0, 0, 1), vec4<i32>(0, 1, 1, 0), vec4<i32>(6, 0, 0, 1),
        vec4<i32>(10, 2, 0, 0), vec4<i32>(6, 0, 0, 0), vec4<i32>(3, 0, 0, 0),
        vec4<i32>(11, 1, 0, 0), vec4<i32>(4, 1, 1, 0), vec4<i32>(3, 0, 1, 0),
        vec4<i32>(0, 0, 1, 1), vec4<i32>(4, 0, 0, 0), vec4<i32>(5, 0, 1, 0),
        vec4<i32>(0, 0, 1, 0), vec4<i32>(7, 0, 1, 0), vec4<i32>(11, 1, 1, 0),
        vec4<i32>(7, 0, 0, 0), vec4<i32>(10, 1, 0, 0), vec4<i32>(12, 2, 0, 0),
        vec4<i32>(6, 1, 0, 1), vec4<i32>(7, 1, 0, 1), vec4<i32>(4, 0, 0, 1),
        vec4<i32>(3, 0, 0, 1), vec4<i32>(3, 0, 1, 1), vec4<i32>(4, 0, 1, 0),
        vec4<i32>(6, 1, 0, 0), vec4<i32>(11, 0, 0, 0), vec4<i32>(8, 0, 0, 1),
        vec4<i32>(5, 0, 0, 1), vec4<i32>(14, 2, 0, 0), vec4<i32>(5, 0, 0, 0),
        vec4<i32>(12, 1, 0, 0), vec4<i32>(10, 1, 1, 0), vec4<i32>(4, 0, 1, 1),
        vec4<i32>(12, 1, 1, 0), vec4<i32>(7, 1, 0, 0), vec4<i32>(11, 0, 1, 0),
        vec4<i32>(10, 0, 0, 0), vec4<i32>(13, 2, 0, 0), vec4<i32>(10, 0, 0, 1),
        vec4<i32>(11, 0, 0, 1), vec4<i32>(9, 0, 1, 0), vec4<i32>(8, 0, 1, 0),
        vec4<i32>(6, 2, 0, 0), vec4<i32>(8, 0, 0, 0), vec4<i32>(9, 0, 0, 1),
        vec4<i32>(14, 1, 0, 0), vec4<i32>(5, 1, 0, 1), vec4<i32>(16, 0, 1, 1),
        vec4<i32>(8, 1, 0, 1), vec4<i32>(5, 1, 0, 0), vec4<i32>(12, 0, 0, 0),
        vec4<i32>(7, 2, 0, 0), vec4<i32>(12, 0, 1, 0), vec4<i32>(10, 0, 1, 0),
        vec4<i32>(9, 0, 0, 0), vec4<i32>(13, 1, 0, 0), vec4<i32>(16, 0, 0, 1),
        vec4<i32>(15, 0, 1, 1), vec4<i32>(15, 0, 1, 0), vec4<i32>(16, 0, 1, 0),
        vec4<i32>(14, 1, 1, 0), vec4<i32>(13, 1, 1, 0), vec4<i32>(5, 2, 0, 0),
        vec4<i32>(8, 1, 0, 0), vec4<i32>(14, 0, 0, 0), vec4<i32>(9, 1, 0, 1),
        vec4<i32>(14, 0, 0, 1), vec4<i32>(17, 0, 0, 1), vec4<i32>(12, 0, 0, 1),
        vec4<i32>(16, 0, 0, 0), vec4<i32>(17, 0, 1, 1), vec4<i32>(15, 0, 0, 1),
        vec4<i32>(16, 1, 0, 1), vec4<i32>(9, 1, 0, 0), vec4<i32>(15, 0, 0, 0),
        vec4<i32>(13, 0, 0, 0), vec4<i32>(8, 2, 0, 0), vec4<i32>(13, 0, 1, 0),
        vec4<i32>(17, 1, 0, 1), vec4<i32>(19, 0, 1, 0), vec4<i32>(14, 0, 1, 0),
        vec4<i32>(19, 0, 1, 1), vec4<i32>(17, 0, 1, 0), vec4<i32>(13, 0, 0, 1),
        vec4<i32>(17, 0, 0, 0), vec4<i32>(16, 1, 0, 0), vec4<i32>(9, 2, 0, 0),
        vec4<i32>(15, 1, 0, 1), vec4<i32>(15, 1, 0, 0), vec4<i32>(18, 0, 1, 1),
        vec4<i32>(18, 0, 0, 1), vec4<i32>(19, 0, 0, 1), vec4<i32>(17, 1, 0, 0),
        vec4<i32>(19, 0, 0, 0), vec4<i32>(18, 0, 1, 0), vec4<i32>(18, 1, 0, 1),
        vec4<i32>(19, 2, 0, 0), vec4<i32>(19, 1, 0, 0), vec4<i32>(18, 0, 0, 0),
        vec4<i32>(19, 1, 0, 1), vec4<i32>(18, 1, 0, 0)
    );
    let value = values[min(baseCell, H3_MAX_BASE_CELL)];
    return H3FaceIJK(u32(value.x), value.yzw, select(1u, 0u, baseCell > H3_MAX_BASE_CELL));
}

fn h3_get_face_basis(face: u32) -> H3FaceBasis {
    // Cartesian face centers and tangent directions derived in f64 from H3
    // 4.4.1 faceCenterGeo and faceAxesAzRadsCII, then rounded once to f32.
    let values = array<H3FaceBasis, 20>(
        H3FaceBasis(vec3<f32>(0.21993077914046064, 0.65836917802749961, 0.71984753789261824), vec3<f32>(0.40421480869336979, -0.73308947628163668, 0.54698282258047015), vec3<f32>(0.88782928585379106, 0.17067467647108681, -0.42735151104428948)),
        H3FaceBasis(vec3<f32>(-0.21392348345014206, 0.14781718295507032, 0.96560179352142050), vec3<f32>(0.97213741150647937, -0.064768238219792551, 0.22528632552240305), vec3<f32>(0.095841516985274933, 0.98689166362936298, -0.12984316647721508)),
        H3FaceBasis(vec3<f32>(0.10926252787847968, -0.48119515728732093, 0.86977751212872534), vec3<f32>(0.54908143033305923, 0.75861960482905433, 0.35072193833920812), vec3<f32>(-0.82859597082354097, 0.43925791486578813, 0.34710402095445936)),
        H3FaceBasis(vec3<f32>(0.74285673015867915, -0.35939416782780276, 0.56480059365170332), vec3<f32>(-0.28030414798915992, 0.59918003969486122, 0.74994190751773282), vec3<f32>(-0.60794198989543935, -0.71541534241489801, 0.34436524905882676)),
        H3FaceBasis(vec3<f32>(0.81125347091409694, 0.34489532376393839, 0.47213877364139301), vec3<f32>(-0.36983664399785920, -0.32274687375841976, 0.87123780464094147), vec3<f32>(0.45286715787991422, -0.88140891255133935, -0.13427459249178184)),
        H3FaceBasis(vec3<f32>(-0.10554981496139205, 0.97944572964114129, 0.17188746100093655), vec3<f32>(-0.44790444934378915, 0.10749984883348690, -0.88759528319995851), vec3<f32>(-0.88782928585379128, -0.17067467647108650, 0.42735151104428898)),
        H3FaceBasis(vec3<f32>(-0.80754075799700920, 0.15335524858988187, 0.56952619948826877), vec3<f32>(-0.58197278956629661, -0.050269394155928071, -0.81165304177069331), vec3<f32>(-0.095841516985274960, -0.98689166362936276, 0.12984316647721500)),
        H3FaceBasis(vec3<f32>(-0.28461480697879066, -0.86440809726542056, 0.41447925524735385), vec3<f32>(-0.48210281972149821, -0.24464489696238384, -0.84126437319480318), vec3<f32>(0.82859597082354086, -0.43925791486578813, -0.34710402095445930)),
        H3FaceBasis(vec3<f32>(0.74056214738544812, -0.66732995645655235, -0.078983764632673703), vec3<f32>(-0.28631144367947847, -0.20700632128770857, -0.93550742389630603), vec3<f32>(0.60794198989543935, 0.71541534241489801, -0.34436524905882648)),
        H3FaceBasis(vec3<f32>(0.85123039864742933, 0.47223437885826808, -0.22891373886878078), vec3<f32>(-0.26517568842619710, 0.010631100573831070, -0.96414150100920437), vec3<f32>(-0.45286715787991411, 0.88140891255133957, 0.13427459249178192)),
        H3FaceBasis(vec3<f32>(-0.74056214738544812, 0.66732995645655235, 0.078983764632673703), vec3<f32>(0.28631144367947842, 0.20700632128770849, 0.93550742389630615), vec3<f32>(0.60794198989543946, 0.71541534241489813, -0.34436524905882643)),
        H3FaceBasis(vec3<f32>(-0.85123039864742922, -0.47223437885826824, 0.22891373886878078), vec3<f32>(0.26517568842619699, -0.010631100573830890, 0.96414150100920437), vec3<f32>(-0.45286715787991433, 0.88140891255133946, 0.13427459249178178)),
        H3FaceBasis(vec3<f32>(0.10554981496139196, -0.97944572964114129, -0.17188746100093655), vec3<f32>(0.44790444934378937, -0.10749984883348687, 0.88759528319995840), vec3<f32>(-0.88782928585379117, -0.17067467647108642, 0.42735151104428915)),
        H3FaceBasis(vec3<f32>(0.80754075799700920, -0.15335524858988192, -0.56952619948826877), vec3<f32>(0.58197278956629672, 0.050269394155928224, 0.81165304177069331), vec3<f32>(-0.095841516985274919, -0.98689166362936276, 0.12984316647721517)),
        H3FaceBasis(vec3<f32>(0.28461480697879077, 0.86440809726542045, -0.41447925524735385), vec3<f32>(0.48210281972149854, 0.24464489696238367, 0.84126437319480307), vec3<f32>(0.82859597082354075, -0.43925791486578830, -0.34710402095445958)),
        H3FaceBasis(vec3<f32>(-0.74285673015867915, 0.35939416782780270, -0.56480059365170332), vec3<f32>(0.28030414798915992, -0.59918003969486122, -0.74994190751773282), vec3<f32>(-0.60794198989543935, -0.71541534241489801, 0.34436524905882682)),
        H3FaceBasis(vec3<f32>(-0.81125347091409705, -0.34489532376393828, -0.47213877364139301), vec3<f32>(0.36983664399785943, 0.32274687375841943, -0.87123780464094158), vec3<f32>(0.45286715787991400, -0.88140891255133968, -0.13427459249178153)),
        H3FaceBasis(vec3<f32>(-0.21993077914046069, -0.65836917802749961, -0.71984753789261824), vec3<f32>(-0.40421480869336934, 0.73308947628163679, -0.54698282258047037), vec3<f32>(0.88782928585379106, 0.17067467647108642, -0.42735151104428926)),
        H3FaceBasis(vec3<f32>(0.21392348345014203, -0.14781718295507038, -0.96560179352142050), vec3<f32>(-0.97213741150647948, 0.064768238219792718, -0.22528632552240305), vec3<f32>(0.095841516985275099, 0.98689166362936298, -0.12984316647721511)),
        H3FaceBasis(vec3<f32>(-0.10926252787847962, 0.48119515728732093, -0.86977751212872534), vec3<f32>(-0.54908143033305945, -0.75861960482905422, -0.35072193833920812), vec3<f32>(-0.82859597082354097, 0.43925791486578836, 0.34710402095445941))
    );
    return values[min(face, 19u)];
}

fn h3_get_face_basis_low(face: u32) -> H3FaceBasis {
    // Residuals after rounding the f64 basis above to f32.
    let values = array<H3FaceBasis, 20>(
        H3FaceBasis(vec3<f32>(-3.77370104609475732e-9, -5.51284462524392893e-9, -2.20362758041048323e-8), vec3<f32>(9.28922549991995083e-9, -2.92601523010915798e-8, -2.22192853005509505e-9), vec3<f32>(-1.78876640166691914e-8, -5.19242637775363391e-9, -6.48000419989358534e-9)),
        H3FaceBasis(vec3<f32>(6.36848296320380314e-10, 3.39440900387621980e-9, -8.35083291406135686e-9), vec3<f32>(1.99392491406769068e-8, 1.63597374536195161e-9, 5.67052774180787367e-9), vec3<f32>(-2.54931292742455184e-9, -2.32869883376451980e-8, -5.96715191147900725e-9)),
        H3FaceBasis(vec3<f32>(1.84317083817830962e-9, -5.48144324374888470e-9, 1.14993002897634256e-8), vec3<f32>(-1.44072361818459171e-8, -1.66584923633195103e-9, 1.28421530631861458e-8), vec3<f32>(2.50794741640802954e-8, -4.92257246076377442e-9, 7.98830335213551734e-9)),
        H3FaceBasis(vec3<f32>(-1.07928589399008956e-8, -4.93450746930079731e-9, -2.64273372074796953e-8), vec3<f32>(-1.40971005979650954e-8, -3.04882163959518948e-9, 2.20463888256361429e-8), vec3<f32>(-4.76512929115102679e-9, 1.61284979816045393e-8, 9.91545517914360630e-9)),
        H3FaceBasis(vec3<f32>(-1.71497153145239167e-8, -9.28774313013747133e-9, 1.11673329472594673e-8), vec3<f32>(1.42415054193989477e-8, -8.56503257207208435e-10, -9.78548064800577322e-9), vec3<f32>(7.57321255706600027e-9, 1.72734897496695794e-8, -5.45660269746228721e-9)),
        H3FaceBasis(vec3<f32>(-2.64449752374051883e-9, -2.58405786768278745e-8, 3.63017849114299906e-9), vec3<f32>(-1.15634088970750781e-8, 3.50754009170728409e-9, 1.27061083876611747e-8), vec3<f32>(1.78876637946245864e-8, 5.19242668306496569e-9, 6.48000370029322426e-9)),
        H3FaceBasis(vec3<f32>(1.63483887538617978e-8, -7.13311770761393404e-9, 3.96214572262465481e-9), vec3<f32>(-1.17228212692666034e-8, 9.57063261974866464e-10, -2.37729516072704428e-8), vec3<f32>(2.54931289966897623e-9, 2.32869885596898030e-8, 5.96715182821228041e-9)),
        H3FaceBasis(vec3<f32>(-5.57193030603642114e-9, -2.14559418010296099e-8, -4.28915680750208139e-10), vec3<f32>(-8.38498087629702127e-9, -1.76642284133166072e-9, -6.09122652317495294e-9), vec3<f32>(-2.50794742751025979e-8, 4.92257246076377442e-9, -7.98830329662436611e-9)),
        H3FaceBasis(vec3<f32>(6.44382824876998939e-9, 1.05653897852775458e-8, -3.26249166571201954e-9), vec3<f32>(3.94091337341251347e-9, -9.30385879449602271e-10, -7.17114734261059539e-9), vec3<f32>(4.76512929115102679e-9, -1.61284979816045393e-8, -9.91545490158785015e-9)),
        H3FaceBasis(vec3<f32>(1.57281178081447592e-8, 1.05339882927601991e-8, 4.54835252794438816e-10), vec3<f32>(1.17614860073445016e-8, 2.99208630094582873e-10, -1.29339480237078419e-8), vec3<f32>(-7.57321244604369781e-9, -1.72734895276249745e-8, 5.45660278072901406e-9)),
        H3FaceBasis(vec3<f32>(-6.44382824876998939e-9, -1.05653897852775458e-8, 3.26249166571201954e-9), vec3<f32>(-3.94091342892366470e-9, 9.30385796182875424e-10, 7.17114745363289785e-9), vec3<f32>(4.76512940217332925e-9, -1.61284978705822368e-8, -9.91545484607669891e-9)),
        H3FaceBasis(vec3<f32>(-1.57281176971224568e-8, -1.05339884592936528e-8, -4.54835252794438816e-10), vec3<f32>(-1.17614861183668040e-8, -2.99208449683341371e-10, 1.29339480237078419e-8), vec3<f32>(-7.57321266808830273e-9, -1.72734896386472769e-8, 5.45660264195113598e-9)),
        H3FaceBasis(vec3<f32>(2.64449742659600417e-9, 2.58405786768278745e-8, -3.63017849114299906e-9), vec3<f32>(1.15634091191196831e-8, -3.50754006395170848e-9, -1.27061084986834771e-8), vec3<f32>(1.78876639056468889e-8, 5.19242676633169253e-9, 6.48000386682667795e-9)),
        H3FaceBasis(vec3<f32>(-1.63483887538617978e-8, 7.13311765210278281e-9, -3.96214572262465481e-9), vec3<f32>(1.17228213802889059e-8, -9.57063109319200578e-10, 2.37729516072704428e-8), vec3<f32>(2.54931294130233965e-9, 2.32869885596898030e-8, 5.96715199474573410e-9)),
        H3FaceBasis(vec3<f32>(5.57193041705872361e-9, 2.14559416900073074e-8, 4.28915680750208139e-10), vec3<f32>(8.38498120936392866e-9, 1.76642267479820703e-9, 6.09122641215265048e-9), vec3<f32>(-2.50794743861249003e-8, 4.92257229423032072e-9, -7.98830357418012227e-9)),
        H3FaceBasis(vec3<f32>(1.07928589399008956e-8, 4.93450741378964608e-9, 2.64273372074796953e-8), vec3<f32>(1.40971005979650954e-8, 3.04882163959518948e-9, -2.20463888256361429e-8), vec3<f32>(-4.76512929115102679e-9, 1.61284979816045393e-8, 9.91545523465475753e-9)),
        H3FaceBasis(vec3<f32>(1.71497152035016143e-8, 9.28774324115977379e-9, -1.11673329472594673e-8), vec3<f32>(-1.42415051973543427e-8, 8.56502924140301047e-10, 9.78548053698347076e-9), vec3<f32>(7.57321233502139535e-9, 1.72734894166026720e-8, -5.45660239215095544e-9)),
        H3FaceBasis(vec3<f32>(3.77370099058360609e-9, 5.51284462524392893e-9, 2.20362758041048323e-8), vec3<f32>(-9.28922505583074098e-9, 2.92601524121138823e-8, 2.22192830801049013e-9), vec3<f32>(-1.78876640166691914e-8, -5.19242676633169253e-9, -6.48000397784898041e-9)),
        H3FaceBasis(vec3<f32>(-6.36848324075955929e-10, -3.39440905938737103e-9, 8.35083291406135686e-9), vec3<f32>(-1.99392492516992093e-8, -1.63597357882849792e-9, -5.67052774180787367e-9), vec3<f32>(-2.54931276089109815e-9, -2.32869883376451980e-8, -5.96715193923458287e-9)),
        H3FaceBasis(vec3<f32>(-1.84317078266715839e-9, 5.48144324374888470e-9, -1.14993002897634256e-8), vec3<f32>(1.44072359598013122e-8, 1.66584934735425350e-9, -1.28421530631861458e-8), vec3<f32>(2.50794741640802954e-8, -4.92257223871916949e-9, 7.98830340764666857e-9))
    );
    return values[min(face, 19u)];
}

fn h3_get_max_dimension(resolution: u32) -> i32 {
    switch resolution {
        case 4u: { return 98; }
        case 6u: { return 686; }
        case 8u: { return 4802; }
        default: { return -1; }
    }
}

fn h3_get_unit_scale(resolution: u32) -> i32 {
    switch resolution {
        case 4u: { return 49; }
        case 6u: { return 343; }
        case 8u: { return 2401; }
        default: { return -1; }
    }
}

fn h3_ijk_normalize(coord: vec3<i32>) -> vec3<i32> {
    var normalized = coord;
    if (normalized.x < 0) {
        normalized.y -= normalized.x;
        normalized.z -= normalized.x;
        normalized.x = 0;
    }
    if (normalized.y < 0) {
        normalized.x -= normalized.y;
        normalized.z -= normalized.y;
        normalized.y = 0;
    }
    if (normalized.z < 0) {
        normalized.x -= normalized.z;
        normalized.y -= normalized.z;
        normalized.z = 0;
    }
    let minimumValue = min(normalized.x, min(normalized.y, normalized.z));
    if (minimumValue > 0) {
        normalized -= vec3<i32>(minimumValue);
    }
    return normalized;
}

fn h3_get_unit_vector(digit: u32) -> vec3<i32> {
    switch digit {
        case 1u: { return vec3<i32>(0, 0, 1); }
        case 2u: { return vec3<i32>(0, 1, 0); }
        case 3u: { return vec3<i32>(0, 1, 1); }
        case 4u: { return vec3<i32>(1, 0, 0); }
        case 5u: { return vec3<i32>(1, 0, 1); }
        case 6u: { return vec3<i32>(1, 1, 0); }
        default: { return vec3<i32>(0); }
    }
}

fn h3_neighbor(coord: vec3<i32>, digit: u32) -> vec3<i32> {
    if (digit > 0u && digit < H3_UNUSED_DIGIT) {
        return h3_ijk_normalize(coord + h3_get_unit_vector(digit));
    }
    return coord;
}

fn h3_down_ap3(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(2, 0, 1) * coord.x +
        vec3<i32>(1, 2, 0) * coord.y +
        vec3<i32>(0, 1, 2) * coord.z
    );
}

fn h3_down_ap3r(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(2, 1, 0) * coord.x +
        vec3<i32>(0, 2, 1) * coord.y +
        vec3<i32>(1, 0, 2) * coord.z
    );
}

fn h3_down_ap7(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(3, 0, 1) * coord.x +
        vec3<i32>(1, 3, 0) * coord.y +
        vec3<i32>(0, 1, 3) * coord.z
    );
}

fn h3_down_ap7r(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(3, 1, 0) * coord.x +
        vec3<i32>(0, 3, 1) * coord.y +
        vec3<i32>(1, 0, 3) * coord.z
    );
}

fn h3_round_divide_by_7(value: i32) -> i32 {
    return select((value - 3) / 7, (value + 3) / 7, value >= 0);
}

fn h3_up_ap7r(coord: vec3<i32>) -> vec3<i32> {
    let i = coord.x - coord.z;
    let j = coord.y - coord.z;
    return h3_ijk_normalize(vec3<i32>(
        h3_round_divide_by_7(2 * i + j),
        h3_round_divide_by_7(3 * j - i),
        0
    ));
}

fn h3_rotate_ijk_ccw(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(1, 1, 0) * coord.x +
        vec3<i32>(0, 1, 1) * coord.y +
        vec3<i32>(1, 0, 1) * coord.z
    );
}

fn h3_rotate_ijk_cw(coord: vec3<i32>) -> vec3<i32> {
    return h3_ijk_normalize(
        vec3<i32>(1, 0, 1) * coord.x +
        vec3<i32>(1, 1, 0) * coord.y +
        vec3<i32>(0, 1, 1) * coord.z
    );
}

fn h3_neighbor_faces(face: u32) -> vec4<u32> {
    let values = array<vec4<u32>, 20>(
        vec4<u32>(0, 4, 1, 5), vec4<u32>(1, 0, 2, 6),
        vec4<u32>(2, 1, 3, 7), vec4<u32>(3, 2, 4, 8),
        vec4<u32>(4, 3, 0, 9), vec4<u32>(5, 10, 14, 0),
        vec4<u32>(6, 11, 10, 1), vec4<u32>(7, 12, 11, 2),
        vec4<u32>(8, 13, 12, 3), vec4<u32>(9, 14, 13, 4),
        vec4<u32>(10, 5, 6, 15), vec4<u32>(11, 6, 7, 16),
        vec4<u32>(12, 7, 8, 17), vec4<u32>(13, 8, 9, 18),
        vec4<u32>(14, 9, 5, 19), vec4<u32>(15, 16, 19, 10),
        vec4<u32>(16, 17, 15, 11), vec4<u32>(17, 18, 16, 12),
        vec4<u32>(18, 19, 17, 13), vec4<u32>(19, 15, 18, 14)
    );
    return values[min(face, 19u)];
}

fn h3_adjacent_face_direction(originFace: u32, destinationFace: u32) -> u32 {
    if (originFace >= 20u || destinationFace >= 20u) {
        return 4u;
    }
    let neighbors = h3_neighbor_faces(originFace);
    if (neighbors.x == destinationFace) { return 0u; }
    if (neighbors.y == destinationFace) { return H3_IJ; }
    if (neighbors.z == destinationFace) { return H3_KI; }
    if (neighbors.w == destinationFace) { return H3_JK; }
    return 4u;
}

fn h3_neighbor_translation(face: u32, direction: u32) -> vec3<i32> {
    let polarBand = face < 5u || face >= 15u;
    if (direction == H3_IJ) {
        return select(vec3<i32>(2, 2, 0), vec3<i32>(2, 0, 2), polarBand);
    }
    if (direction == H3_KI) {
        return select(vec3<i32>(2, 0, 2), vec3<i32>(2, 2, 0), polarBand);
    }
    return vec3<i32>(0, 2, 2);
}

fn h3_neighbor_rotations(face: u32, direction: u32) -> u32 {
    if (direction == H3_JK) {
        return 3u;
    }
    let polarBand = face < 5u || face >= 15u;
    if (!polarBand) {
        return 3u;
    }
    return select(5u, 1u, direction == H3_IJ);
}

fn h3_transform_to_neighbor(
    source: H3FaceIJK,
    direction: u32,
    scale: i32
) -> H3FaceIJK {
    if (source.valid == 0u || source.face >= 20u || direction < 1u || direction > 3u || scale < 0) {
        return H3FaceIJK(0u, vec3<i32>(0), 0u);
    }
    let destinationFace = h3_neighbor_faces(source.face)[direction];
    var coord = source.coord;
    let rotations = h3_neighbor_rotations(source.face, direction);
    var rotation = 0u;
    loop {
        if (rotation >= rotations) {
            break;
        }
        coord = h3_rotate_ijk_ccw(coord);
        rotation += 1u;
    }
    coord = h3_ijk_normalize(coord + h3_neighbor_translation(source.face, direction) * scale);
    return H3FaceIJK(destinationFace, coord, 1u);
}

fn h3_adjust_overage(
    source: H3FaceIJK,
    resolution: u32,
    pentagonLeading4: bool,
    substrate: bool
) -> H3BoundaryVertex {
    let baseMaximumDimension = h3_get_max_dimension(resolution);
    let baseUnitScale = h3_get_unit_scale(resolution);
    if (source.valid == 0u || source.face >= 20u || baseMaximumDimension < 0 || baseUnitScale < 0) {
        return H3BoundaryVertex(0u, vec3<i32>(0), resolution, H3_NO_OVERAGE, 0u);
    }

    let factor = select(1, 3, substrate);
    let maximumDimension = baseMaximumDimension * factor;
    let dimension = source.coord.x + source.coord.y + source.coord.z;
    if (substrate && dimension == maximumDimension) {
        return H3BoundaryVertex(source.face, source.coord, resolution, H3_FACE_EDGE, 1u);
    }
    if (dimension <= maximumDimension) {
        return H3BoundaryVertex(source.face, source.coord, resolution, H3_NO_OVERAGE, 1u);
    }

    var coord = source.coord;
    var direction = H3_IJ;
    if (coord.z > 0) {
        direction = select(H3_KI, H3_JK, coord.y > 0);
        if (direction == H3_KI && pentagonLeading4) {
            let origin = vec3<i32>(maximumDimension, 0, 0);
            coord = h3_rotate_ijk_cw(coord - origin) + origin;
        }
    }
    let transformed = h3_transform_to_neighbor(
        H3FaceIJK(source.face, coord, 1u),
        direction,
        baseUnitScale * factor
    );
    if (transformed.valid == 0u) {
        return H3BoundaryVertex(0u, vec3<i32>(0), resolution, H3_NEW_FACE, 0u);
    }
    let transformedDimension = transformed.coord.x + transformed.coord.y + transformed.coord.z;
    let overage = select(H3_NEW_FACE, H3_FACE_EDGE, substrate && transformedDimension == maximumDimension);
    return H3BoundaryVertex(transformed.face, transformed.coord, resolution, overage, 1u);
}

fn h3_get_center_face_ijk(index: vec2<u32>) -> H3FaceIJK {
    let baseCell = h3_get_base_cell(index);
    let resolution = h3_get_resolution(index);
    let baseCellPentagon = h3_is_base_cell_pentagon(baseCell);
    let originalLeadingDigit = h3_leading_nonzero_digit(index);
    let rotatePentagon = baseCellPentagon && originalLeadingDigit == 5u;
    var center = h3_get_base_cell_home(baseCell);

    var currentResolution = 1u;
    loop {
        if (currentResolution > resolution) {
            break;
        }
        center.coord = select(
            h3_down_ap7r(center.coord),
            h3_down_ap7(center.coord),
            h3_is_class_iii(currentResolution)
        );
        center.coord = h3_neighbor(
            center.coord,
            h3_effective_digit(index, currentResolution, rotatePentagon)
        );
        currentResolution += 1u;
    }

    let originalCoord = center.coord;
    var adjustedResolution = resolution;
    if (h3_is_class_iii(resolution)) {
        center.coord = h3_down_ap7r(center.coord);
        adjustedResolution += 1u;
    }

    let effectiveLeadingDigit = select(originalLeadingDigit, h3_rotate_digit_cw(originalLeadingDigit), rotatePentagon);
    var adjusted = h3_adjust_overage(
        center,
        adjustedResolution,
        baseCellPentagon && effectiveLeadingDigit == 4u,
        false
    );
    if (adjusted.valid == 0u) {
        return H3FaceIJK(0u, vec3<i32>(0), 0u);
    }

    if (adjusted.overage == H3_NEW_FACE) {
        center = H3FaceIJK(adjusted.face, adjusted.coord, 1u);
        if (baseCellPentagon) {
            var secondaryCount = 0u;
            loop {
                if (secondaryCount >= 5u) {
                    return H3FaceIJK(0u, vec3<i32>(0), 0u);
                }
                adjusted = h3_adjust_overage(center, adjustedResolution, false, false);
                if (adjusted.valid == 0u) {
                    return H3FaceIJK(0u, vec3<i32>(0), 0u);
                }
                center = H3FaceIJK(adjusted.face, adjusted.coord, 1u);
                if (adjusted.overage != H3_NEW_FACE) {
                    break;
                }
                secondaryCount += 1u;
            }
        }
        if (adjustedResolution != resolution) {
            center.coord = h3_up_ap7r(center.coord);
        }
    } else if (adjustedResolution != resolution) {
        center.coord = originalCoord;
    }
    return center;
}

fn h3_get_vertex_offset(resolution: u32, vertexIndex: u32) -> vec3<i32> {
    let pointIndex = vertexIndex % 6u;
    if (h3_is_class_iii(resolution)) {
        let vertices = array<vec3<i32>, 6>(
            vec3<i32>(5, 4, 0), vec3<i32>(1, 5, 0), vec3<i32>(0, 5, 4),
            vec3<i32>(0, 1, 5), vec3<i32>(4, 0, 5), vec3<i32>(5, 0, 1)
        );
        return vertices[pointIndex];
    }
    let vertices = array<vec3<i32>, 6>(
        vec3<i32>(2, 1, 0), vec3<i32>(1, 2, 0), vec3<i32>(0, 2, 1),
        vec3<i32>(0, 1, 2), vec3<i32>(1, 0, 2), vec3<i32>(2, 0, 1)
    );
    return vertices[pointIndex];
}

fn h3_make_boundary_vertex(
    centerCoord: vec3<i32>,
    centerFace: u32,
    cellResolution: u32,
    vertexIndex: u32
) -> H3BoundaryVertex {
    var adjustedResolution = cellResolution;
    var substrateCenter = h3_down_ap3r(h3_down_ap3(centerCoord));
    if (h3_is_class_iii(cellResolution)) {
        substrateCenter = h3_down_ap7r(substrateCenter);
        adjustedResolution += 1u;
    }
    return H3BoundaryVertex(
        centerFace,
        h3_ijk_normalize(substrateCenter + h3_get_vertex_offset(cellResolution, vertexIndex)),
        adjustedResolution,
        H3_NO_OVERAGE,
        1u
    );
}

fn h3_adjust_boundary_vertex(vertex: H3BoundaryVertex, pentagon: bool) -> H3BoundaryVertex {
    var adjusted = h3_adjust_overage(
        H3FaceIJK(vertex.face, vertex.coord, vertex.valid),
        vertex.resolution,
        false,
        true
    );
    if (!pentagon || adjusted.valid == 0u) {
        return adjusted;
    }
    var count = 0u;
    loop {
        if (adjusted.overage != H3_NEW_FACE) {
            break;
        }
        if (count >= 5u) {
            return H3BoundaryVertex(0u, vec3<i32>(0), vertex.resolution, H3_NEW_FACE, 0u);
        }
        adjusted = h3_adjust_overage(
            H3FaceIJK(adjusted.face, adjusted.coord, adjusted.valid),
            vertex.resolution,
            false,
            true
        );
        if (adjusted.valid == 0u) {
            break;
        }
        count += 1u;
    }
    return adjusted;
}

fn h3_ijk_to_hex2d(coord: vec3<i32>) -> vec2<f32> {
    let i = f32(coord.x - coord.z);
    let j = f32(coord.y - coord.z);
    return vec2<f32>(i - 0.5 * j, j * H3_SQRT3_OVER_2);
}

fn h3_projection_scale(resolution: u32, substrate: bool) -> vec2<f32> {
    if (substrate) {
        switch resolution {
            case 4u: { return vec2<f32>(0.0025984082397966317, 9.5829241677364285e-11); }
            case 5u: { return vec2<f32>(0.00037120117711380446, 9.5322015255042136e-12); }
            case 6u: { return vec2<f32>(0.00037120117711380451, 9.5322015797143223e-12); }
            case 7u, 8u: { return vec2<f32>(0.000053028739587686342, -1.9739070810818535e-13); }
            default: { return vec2<f32>(0.0); }
        }
    }
    switch resolution {
        case 4u: { return vec2<f32>(0.0077952247193898956, -1.7817356184196553e-10); }
        case 5u: { return vec2<f32>(0.0029463180030527025, 1.0866843752968536e-10); }
        case 6u: { return vec2<f32>(0.0011136035313414135, 5.7700435141666562e-11); }
        case 7u: { return vec2<f32>(0.00042090257186467174, 7.2086823272796141e-12); }
        case 8u: { return vec2<f32>(0.00015908621876305903, -4.2301509246400054e-12); }
        default: { return vec2<f32>(0.0); }
    }
}

fn h3_float2_normalize(value: vec2<f32>) -> vec2<f32> {
    let high = value.x + value.y;
    return vec2<f32>(high, value.y - (high - value.x));
}

fn h3_float2_sum(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    let high = a.x + b.x;
    let bVirtual = high - a.x;
    let error = (a.x - (high - bVirtual)) + (b.x - bVirtual);
    return h3_float2_normalize(vec2<f32>(high, error + a.y + b.y));
}

fn h3_two_product(a: f32, b: f32) -> vec2<f32> {
    // Splitting by significand bits preserves the product residual without
    // relying on a backend to implement fma as a fused operation.
    let high = a * b;
    let aHigh = bitcast<f32>(bitcast<u32>(a) & 0xfffff000u);
    let bHigh = bitcast<f32>(bitcast<u32>(b) & 0xfffff000u);
    let aLow = a - aHigh;
    let bLow = b - bHigh;
    let low = ((aHigh * bHigh - high) + aHigh * bLow + aLow * bHigh) + aLow * bLow;
    return vec2<f32>(high, low);
}

fn h3_float2_product(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    let product = h3_two_product(a.x, b.x);
    let correction = a.x * b.y + a.y * b.x;
    return h3_float2_normalize(vec2<f32>(product.x, product.y + correction));
}

fn h3_cartesian_component(
    center: vec2<f32>,
    axisX: vec2<f32>,
    axisY: vec2<f32>,
    scaledX: vec2<f32>,
    scaledY: vec2<f32>
) -> f32 {
    let withX = h3_float2_sum(center, h3_float2_product(axisX, scaledX));
    return h3_float2_sum(withX, h3_float2_product(axisY, scaledY)).x;
}

fn h3_hex2d_to_cartesian(
    point: vec2<f32>,
    face: u32,
    resolution: u32,
    substrate: bool,
    latticePoint: bool
) -> vec3<f32> {
    var localPoint = point;
    if (!substrate && h3_is_class_iii(resolution)) {
        localPoint = vec2<f32>(
            H3_AP7_ROT_COS * point.x - H3_AP7_ROT_SIN * point.y,
            H3_AP7_ROT_SIN * point.x + H3_AP7_ROT_COS * point.y
        );
    }
    var localPointLow = vec2<f32>(0.0);
    if (latticePoint && (substrate || !h3_is_class_iii(resolution))) {
        let j = round(point.y / H3_SQRT3_OVER_2);
        // Nine-bit chunks make each multiplication by a supported IJK integer exact.
        var preciseY = vec2<f32>(j * 0.865234375, 0.0);
        preciseY = h3_float2_sum(preciseY, vec2<f32>(j * 0.00079059600830078125, 0.0));
        preciseY = h3_float2_sum(preciseY, vec2<f32>(j * 4.3259933590888977e-7, 0.0));
        preciseY = h3_float2_sum(preciseY, vec2<f32>(j * 1.7666934581939131e-10, 0.0));
        preciseY = h3_float2_sum(preciseY, vec2<f32>(j * 1.3256062914024369e-13, 0.0));
        localPoint.y = preciseY.x;
        localPointLow.y = preciseY.y;
    }
    let basis = h3_get_face_basis(face);
    let basisLow = h3_get_face_basis_low(face);
    let scale = h3_projection_scale(resolution, substrate);
    let scaledX = h3_float2_product(vec2<f32>(localPoint.x, localPointLow.x), scale);
    let scaledY = h3_float2_product(vec2<f32>(localPoint.y, localPointLow.y), scale);
    let axisX0 = vec2<f32>(basis.axisX.x, basisLow.axisX.x);
    let axisX1 = vec2<f32>(basis.axisX.y, basisLow.axisX.y);
    let axisY0 = vec2<f32>(basis.axisY.x, basisLow.axisY.x);
    let axisY1 = vec2<f32>(basis.axisY.y, basisLow.axisY.y);
    var x = h3_cartesian_component(
        vec2<f32>(basis.center.x, basisLow.center.x), axisX0, axisY0, scaledX, scaledY
    );
    var y = h3_cartesian_component(
        vec2<f32>(basis.center.y, basisLow.center.y), axisX1, axisY1, scaledX, scaledY
    );
    if (face == 1u || face == 18u) {
        // Subtract the face-plane pole before projection to avoid cancellation.
        let poleX = vec2<f32>(0.23331183195114136, 2.2168690216872733e-9);
        let poleY = select(
            vec2<f32>(-0.13446864485740662, -1.8957176106670914e-9),
            vec2<f32>(0.13446864485740662, 1.8957176384226671e-9),
            face == 18u
        );
        let deltaX = h3_float2_sum(scaledX, -poleX);
        let deltaY = h3_float2_sum(scaledY, -poleY);
        x = h3_cartesian_component(vec2<f32>(0.0), axisX0, axisY0, deltaX, deltaY);
        y = h3_cartesian_component(vec2<f32>(0.0), axisX1, axisY1, deltaX, deltaY);
    }
    let z = h3_cartesian_component(
        vec2<f32>(basis.center.z, basisLow.center.z),
        vec2<f32>(basis.axisX.z, basisLow.axisX.z),
        vec2<f32>(basis.axisY.z, basisLow.axisY.z),
        scaledX,
        scaledY
    );
    return vec3<f32>(x, y, z);
}

fn h3_atan_small(value: f32) -> f32 {
    let squared = value * value;
    var polynomial = 1.0 / 17.0;
    polynomial = -1.0 / 15.0 + squared * polynomial;
    polynomial = 1.0 / 13.0 + squared * polynomial;
    polynomial = -1.0 / 11.0 + squared * polynomial;
    polynomial = 1.0 / 9.0 + squared * polynomial;
    polynomial = -1.0 / 7.0 + squared * polynomial;
    polynomial = 1.0 / 5.0 + squared * polynomial;
    polynomial = -1.0 / 3.0 + squared * polynomial;
    return value * (1.0 + squared * polynomial);
}

fn h3_log_positive(value: f32) -> f32 {
    let bits = bitcast<u32>(value);
    var exponent = i32((bits >> 23u) & 0xffu) - 127;
    var mantissa = bitcast<f32>((bits & 0x007fffffu) | 0x3f800000u);
    if (mantissa > 1.4142135623730951) {
        mantissa *= 0.5;
        exponent += 1;
    }
    let reduced = (mantissa - 1.0) / (mantissa + 1.0);
    let squared = reduced * reduced;
    var polynomial = 1.0 / 11.0;
    polynomial = fma(squared, polynomial, 1.0 / 9.0);
    polynomial = fma(squared, polynomial, 1.0 / 7.0);
    polynomial = fma(squared, polynomial, 1.0 / 5.0);
    polynomial = fma(squared, polynomial, 1.0 / 3.0);
    let logMantissa = 2.0 * reduced * fma(squared, polynomial, 1.0);
    return fma(f32(exponent), 0.6931471805599453, logMantissa);
}

fn h3_cartesian_x(point: vec3<f32>) -> f32 {
    let absX = abs(point.x);
    let absY = abs(point.y);
    var ratio = 0.0;
    if (max(absX, absY) > 0.0) {
        ratio = min(absX, absY) / max(absX, absY);
    }
    var angle = h3_atan_small(ratio);
    if (ratio > 0.4142135623730950) {
        angle = H3_PI * 0.25 + h3_atan_small((ratio - 1.0) / (ratio + 1.0));
    }
    var turn = h3_float2_product(vec2<f32>(angle, 0.0), H3_INV_TWO_PI).x;
    if (absY > absX) {
        turn = 0.25 - turn;
    }
    if (point.x < 0.0) {
        return select(1.0 - turn, turn, point.y < 0.0);
    }
    return select(0.5 + turn, 0.5 - turn, point.y < 0.0);
}

fn h3_cartesian_to_mercator(point: vec3<f32>, referenceX: f32) -> vec2<f32> {
    var x = h3_cartesian_x(point);
    if (x - referenceX > 0.5) { x -= 1.0; }
    if (x - referenceX < -0.5) { x += 1.0; }
    let horizontal = sqrt(fma(point.x, point.x, point.y * point.y));
    var y = select(1.0, 0.0, point.z >= 0.0);
    if (horizontal > 0.0) {
        let latitudeTangent = point.z / horizontal;
        if (latitudeTangent >= H3_SINH_PI) {
            y = 0.0;
        } else if (latitudeTangent <= -H3_SINH_PI) {
            y = 1.0;
        } else {
            let magnitude = abs(latitudeTangent);
            let mercatorLatitude = h3_log_positive(
                magnitude + sqrt(fma(magnitude, magnitude, 1.0))
            );
            let signedLatitude = select(-mercatorLatitude, mercatorLatitude, latitudeTangent >= 0.0);
            let scaledLatitude = h3_float2_product(
                vec2<f32>(signedLatitude, 0.0),
                H3_INV_TWO_PI
            );
            y = h3_float2_sum(vec2<f32>(0.5, 0.0), -scaledLatitude).x;
        }
    }
    return vec2<f32>(x, clamp(y, 0.0, 1.0));
}

fn h3_is_finite_mercator(point: vec2<f32>) -> bool {
    return all(point == point) && all(abs(point) < vec2<f32>(1000000.0));
}

fn h3_append_face_point(
    result: ptr<function, H3ComputeResult>,
    facePoint: vec2<f32>,
    face: u32,
    resolution: u32,
    substrate: bool,
    latticePoint: bool,
    referenceX: f32
) -> u32 {
    if ((*result).count >= H3_RESULT_CAPACITY) {
        return H3_STATUS_TOPOLOGY_OVERFLOW;
    }
    let point = h3_cartesian_to_mercator(
        h3_hex2d_to_cartesian(facePoint, face, resolution, substrate, latticePoint),
        referenceX
    );
    if (!h3_is_finite_mercator(point)) {
        return H3_STATUS_NUMERIC_FAILURE;
    }
    (*result).boundary[(*result).count] = point;
    (*result).count += 1u;
    return H3_STATUS_SUCCESS;
}

fn h3_line_intersection(
    point0: vec2<f32>,
    point1: vec2<f32>,
    edge0: vec2<f32>,
    edge1: vec2<f32>
) -> H3Intersection {
    let line = point1 - point0;
    let edge = edge1 - edge0;
    let denominator = -edge.x * line.y + line.x * edge.y;
    if (abs(denominator) < 1.0e-7) {
        return H3Intersection(vec2<f32>(0.0), 0u, 0u);
    }
    let amount = (edge.x * (point0.y - edge0.y) - edge.y * (point0.x - edge0.x)) / denominator;
    let point = point0 + amount * line;
    let atEndpoint = abs(amount) < 1.0e-6 || abs(amount - 1.0) < 1.0e-6;
    return H3Intersection(point, select(0u, 1u, atEndpoint), select(0u, 1u, all(point == point)));
}

fn h3_face_edge(direction: u32, maximumDimension: i32) -> mat2x2<f32> {
    let dimension = f32(maximumDimension);
    let point0 = vec2<f32>(3.0 * dimension, 0.0);
    let point1 = vec2<f32>(-1.5 * dimension, 3.0 * H3_SQRT3_OVER_2 * dimension);
    let point2 = vec2<f32>(-1.5 * dimension, -3.0 * H3_SQRT3_OVER_2 * dimension);
    if (direction == H3_IJ) { return mat2x2<f32>(point0, point1); }
    if (direction == H3_JK) { return mat2x2<f32>(point1, point2); }
    return mat2x2<f32>(point2, point0);
}

fn h3_hex_boundary(index: vec2<u32>, center: H3FaceIJK) -> H3ComputeResult {
    var result = h3_empty_result(H3_STATUS_SUCCESS);
    let resolution = h3_get_resolution(index);
    let centerCartesian = h3_hex2d_to_cartesian(
        h3_ijk_to_hex2d(center.coord), center.face, resolution, false, true
    );
    if (any(centerCartesian != centerCartesian)) {
        return h3_empty_result(H3_STATUS_NUMERIC_FAILURE);
    }
    let referenceX = h3_cartesian_x(centerCartesian);
    var vertices: array<H3BoundaryVertex, 6>;
    var vertexIndex = 0u;
    loop {
        if (vertexIndex >= 6u) { break; }
        vertices[vertexIndex] = h3_make_boundary_vertex(center.coord, center.face, resolution, vertexIndex);
        vertexIndex += 1u;
    }

    var lastFace = 20u;
    var lastOverage = H3_NO_OVERAGE;
    var iteration = 0u;
    loop {
        if (iteration > 6u) { break; }
        let currentIndex = iteration % 6u;
        let adjusted = h3_adjust_boundary_vertex(vertices[currentIndex], false);
        if (adjusted.valid == 0u) {
            return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
        }

        if (
            h3_is_class_iii(resolution) && iteration > 0u &&
            adjusted.face != lastFace && lastOverage != H3_FACE_EDGE &&
            adjusted.overage != H3_FACE_EDGE
        ) {
            let lastIndex = (currentIndex + 5u) % 6u;
            let point0 = h3_ijk_to_hex2d(vertices[lastIndex].coord);
            let point1 = h3_ijk_to_hex2d(vertices[currentIndex].coord);
            let face2 = select(lastFace, adjusted.face, lastFace == center.face);
            let edgeDirection = h3_adjacent_face_direction(center.face, face2);
            let maximumDimension = h3_get_max_dimension(adjusted.resolution);
            if (edgeDirection < 1u || edgeDirection > 3u || maximumDimension < 0) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            let edge = h3_face_edge(edgeDirection, maximumDimension);
            let intersection = h3_line_intersection(point0, point1, edge[0], edge[1]);
            if (intersection.valid == 0u) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            if (intersection.atEndpoint == 0u) {
                let status = h3_append_face_point(
                    &result,
                    intersection.point,
                    center.face,
                    adjusted.resolution,
                    true,
                    false,
                    referenceX
                );
                if (status != H3_STATUS_SUCCESS) { return h3_empty_result(status); }
            }
        }

        if (iteration < 6u) {
            let status = h3_append_face_point(
                &result,
                h3_ijk_to_hex2d(adjusted.coord),
                adjusted.face,
                adjusted.resolution,
                true,
                true,
                referenceX
            );
            if (status != H3_STATUS_SUCCESS) { return h3_empty_result(status); }
        }
        lastFace = adjusted.face;
        lastOverage = adjusted.overage;
        iteration += 1u;
    }
    return result;
}

fn h3_pentagon_boundary(index: vec2<u32>, center: H3FaceIJK) -> H3ComputeResult {
    var result = h3_empty_result(H3_STATUS_SUCCESS);
    let resolution = h3_get_resolution(index);
    let centerCartesian = h3_hex2d_to_cartesian(
        h3_ijk_to_hex2d(center.coord), center.face, resolution, false, true
    );
    if (any(centerCartesian != centerCartesian)) {
        return h3_empty_result(H3_STATUS_NUMERIC_FAILURE);
    }
    let referenceX = h3_cartesian_x(centerCartesian);
    var vertices: array<H3BoundaryVertex, 5>;
    var vertexIndex = 0u;
    loop {
        if (vertexIndex >= 5u) { break; }
        vertices[vertexIndex] = h3_make_boundary_vertex(center.coord, center.face, resolution, vertexIndex);
        vertexIndex += 1u;
    }

    var last = H3BoundaryVertex(0u, vec3<i32>(0), resolution, H3_NO_OVERAGE, 0u);
    var iteration = 0u;
    loop {
        if (iteration > 5u) { break; }
        let currentIndex = iteration % 5u;
        let adjusted = h3_adjust_boundary_vertex(vertices[currentIndex], true);
        if (adjusted.valid == 0u) {
            return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
        }

        if (h3_is_class_iii(resolution) && iteration > 0u) {
            let currentToLastDirection = h3_adjacent_face_direction(adjusted.face, last.face);
            let unitScale = h3_get_unit_scale(adjusted.resolution);
            if (currentToLastDirection < 1u || currentToLastDirection > 3u || unitScale < 0) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            let transformed = h3_transform_to_neighbor(
                H3FaceIJK(adjusted.face, adjusted.coord, 1u),
                currentToLastDirection,
                unitScale * 3
            );
            if (transformed.valid == 0u || transformed.face != last.face) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            let edgeDirection = h3_adjacent_face_direction(transformed.face, adjusted.face);
            let maximumDimension = h3_get_max_dimension(adjusted.resolution);
            if (edgeDirection < 1u || edgeDirection > 3u || maximumDimension < 0) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            let edge = h3_face_edge(edgeDirection, maximumDimension);
            let intersection = h3_line_intersection(
                h3_ijk_to_hex2d(last.coord),
                h3_ijk_to_hex2d(transformed.coord),
                edge[0],
                edge[1]
            );
            if (intersection.valid == 0u) {
                return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
            }
            let status = h3_append_face_point(
                &result,
                intersection.point,
                transformed.face,
                adjusted.resolution,
                true,
                false,
                referenceX
            );
            if (status != H3_STATUS_SUCCESS) { return h3_empty_result(status); }
        }

        if (iteration < 5u) {
            let status = h3_append_face_point(
                &result,
                h3_ijk_to_hex2d(adjusted.coord),
                adjusted.face,
                adjusted.resolution,
                true,
                true,
                referenceX
            );
            if (status != H3_STATUS_SUCCESS) { return h3_empty_result(status); }
        }
        last = adjusted;
        iteration += 1u;
    }
    return result;
}

fn h3_compute_boundary(index: vec2<u32>) -> H3ComputeResult {
    if (!h3_is_valid_cell(index)) {
        return h3_empty_result(H3_STATUS_INVALID_ID);
    }
    let resolution = h3_get_resolution(index);
    if (resolution < H3_MIN_RESOLUTION || resolution > H3_MAX_RESOLUTION) {
        return h3_empty_result(H3_STATUS_UNSUPPORTED_RESOLUTION);
    }
    let center = h3_get_center_face_ijk(index);
    if (center.valid == 0u) {
        return h3_empty_result(H3_STATUS_FACE_TRANSFORM_FAILED);
    }
    let pentagon = h3_is_base_cell_pentagon(h3_get_base_cell(index)) &&
        h3_leading_nonzero_digit(index) == 0u;
    if (pentagon) {
        return h3_pentagon_boundary(index, center);
    }
    return h3_hex_boundary(index, center);
}

@compute @workgroup_size(64)
fn h3ComputeMain(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let cellIndex = invocation.x;
    if (cellIndex >= arrayLength(&h3Ids) || cellIndex >= arrayLength(&h3Results)) {
        return;
    }
    h3Results[cellIndex] = h3_compute_boundary(h3Ids[cellIndex]);
}
`
