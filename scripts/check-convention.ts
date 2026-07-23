/**
 * Ermittelt numerisch die SCM-Konventionen:
 *  - restPoseInverse: column-major vs row-major (transponiert)
 *  - Bone-Rotation: [w,x,y,z] vs [x,y,z,w]
 * Kriterium: bindWorld(bone) * restPoseInverse(bone) == Identität
 */
import { open, type FileHandle } from 'node:fs/promises'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseScm } from '../src/formats/scm'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(path: string): Promise<NodeFile> {
    const fh = await open(path, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(start: number, end: number): Promise<ArrayBuffer> {
    const buf = Buffer.alloc(end - start)
    await this.fh.read(buf, 0, end - start, start)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

const GAME = 'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

async function main() {
  const zip = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/units.scd`))
  const scm = parseScm(await zip.read(zip.get('units/UEL0001/UEL0001_LOD0.scm')!))

  for (const quatOrder of ['wxyz', 'xyzw'] as const) {
    for (const matOrder of ['colMajor', 'rowMajor'] as const) {
      const worlds: Matrix4[] = []
      let maxErr = 0
      for (let i = 0; i < scm.bones.length; i++) {
        const b = scm.bones[i]!
        const [r0, r1, r2, r3] = b.rotation
        const q =
          quatOrder === 'wxyz'
            ? new Quaternion(r1!, r2!, r3!, r0!) // gespeichert w,x,y,z
            : new Quaternion(r0!, r1!, r2!, r3!) // gespeichert x,y,z,w
        const local = new Matrix4().compose(new Vector3(...b.position), q, new Vector3(1, 1, 1))
        const world =
          b.parent >= 0 ? new Matrix4().multiplyMatrices(worlds[b.parent]!, local) : local
        worlds.push(world)

        const inv = new Matrix4().fromArray(b.restPoseInverse)
        if (matOrder === 'rowMajor') inv.transpose()
        const prod = new Matrix4().multiplyMatrices(world, inv)
        const e = prod.elements
        for (let k = 0; k < 16; k++) {
          const expected = k % 5 === 0 ? 1 : 0
          maxErr = Math.max(maxErr, Math.abs(e[k]! - expected))
        }
      }
      console.log(`quat=${quatOrder} mat=${matOrder}: maxErr=${maxErr.toExponential(3)}`)
    }
  }
}

void main()
