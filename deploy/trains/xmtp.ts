/** Cloud train entrypoint: boot the XMTP station. Mirrors the local
 *  ~/.metro/trains/xmtp.ts symlink (→ packages/metro/src/stations/xmtp/index.ts)
 *  so the containerised supervisor spawns the same station code. */
import '../../packages/metro/src/stations/xmtp/index.ts'
