import { RTCPeerConnection, RtpHeader, RtpPacket, type RTCDataChannel, type RTCRtpSender } from 'werift';
import { errMsg, log } from '@metro-labs/core/log';

const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const UDP_PORTS: [number, number] = [40_000, 40_100];
const GATHER_MS = 2_500;
const OPUS_PT = 111;
const MEDIA = JSON.stringify({ audio: true, video: false, screen: false });

export interface PeerEvents {
  audio(opus: Buffer): void;
  state(state: string): void;
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, GATHER_MS);
    pc.iceGatheringStateChange.subscribe((state) => {
      if (state !== 'complete') return;
      clearTimeout(timer);
      resolve();
    });
  });
}

export class Peer {
  private readonly pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: 'max-bundle',
    icePortRange: UDP_PORTS,
    iceUseIpv6: false,
  });
  private readonly channel: RTCDataChannel;
  private sender: RTCRtpSender | null = null;
  private sequence = Math.floor(Math.random() * 0xffff);
  private closed = false;

  constructor(private readonly events: PeerEvents) {
    this.channel = this.pc.createDataChannel('media', { negotiated: true, id: 0 });
    this.channel.stateChanged.subscribe((state) => {
      if (state === 'open') this.channel.send(MEDIA);
    });
    this.pc.onTrack.subscribe((track) => {
      if (track.kind === 'audio')
        track.onReceiveRtp.subscribe((rtp) => {
          if (!this.closed) this.events.audio(rtp.payload);
        });
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (!this.closed) this.events.state(state);
    });
  }

  async answer(offer: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offer });
    for (const transceiver of this.pc.getTransceivers()) {
      if (transceiver.kind === 'audio') {
        transceiver.setDirection('sendrecv');
        this.sender = transceiver.sender;
      } else transceiver.setDirection('inactive');
    }
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    const sdp = this.pc.localDescription?.sdp;
    if (sdp === undefined) throw new Error('no local description after the answer');
    return sdp;
  }

  sendOpus(payload: Buffer, timestamp: number, marker: boolean): Promise<void> {
    const sender = this.sender;
    if (this.closed || sender === null) return Promise.reject(new Error('call audio transport is closed'));
    this.sequence = (this.sequence + 1) & 0xffff;
    const header = new RtpHeader({ payloadType: OPUS_PT, sequenceNumber: this.sequence, timestamp, marker });
    return sender.sendRtp(new RtpPacket(header, payload));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.close().catch((err: unknown) => {
      log.debug({ err: errMsg(err) }, 'voice: closing the call connection failed');
    });
  }
}
