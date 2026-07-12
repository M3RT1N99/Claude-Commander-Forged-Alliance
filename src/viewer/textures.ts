import * as THREE from 'three'
import { parseDds, type DdsImage } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

/**
 * Erzeugt aus DDS-Rohdaten eine Three.js-Textur. Wenn die GPU S3TC
 * unterstützt (alle Desktop-GPUs), werden die DXT-Blöcke direkt
 * hochgeladen; sonst (Mobile) wird in Software zu RGBA8 dekodiert.
 */
export function ddsToTexture(data: Uint8Array, s3tcSupported: boolean): THREE.Texture {
  const dds = parseDds(data)

  if (dds.format === 'BGRA8') {
    return dataTexture(bgraToRgba(dds.mips[0]!.data), dds)
  }

  if (!s3tcSupported) {
    return dataTexture(decodeDxt(dds.mips[0]!.data, dds.width, dds.height, dds.format), dds)
  }

  const format =
    dds.format === 'DXT1'
      ? THREE.RGBA_S3TC_DXT1_Format
      : dds.format === 'DXT3'
        ? THREE.RGBA_S3TC_DXT3_Format
        : THREE.RGBA_S3TC_DXT5_Format

  const mipmaps = dds.mips.map((m) => ({
    data: m.data,
    width: m.width,
    height: m.height,
  }))

  const tex = new THREE.CompressedTexture(
    mipmaps as unknown as ImageData[],
    dds.width,
    dds.height,
    format,
  )
  tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

function dataTexture(rgba: Uint8Array, dds: DdsImage): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(rgba), dds.width, dds.height, THREE.RGBAFormat)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  // DDS-Daten sind top-down gespeichert; DataTexture lädt bottom-up
  tex.flipY = true
  tex.needsUpdate = true
  return tex
}
