'use client';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';

/**
 * The transport for whichever clip the asset exports.
 *
 * Time is shared with the viewport in one direction at a time, which is the
 * only arrangement that does not fight itself: while `playing`, the viewport
 * advances its mixer and reports `time` up here, and this strip is a readout;
 * while paused, `time` is authoritative and the viewport seeks to it exactly.
 * Scrubbing therefore pauses first — otherwise the next animation frame would
 * overwrite the position the pointer just asked for.
 */

const SPEEDS = [0.25, 0.5, 1, 2];

/** The pose a rig rests in. Not a clip, so it has nothing to scrub. */
export const BIND_POSE = 'Bind pose';

export function Timeline({
  clips,
  current,
  playing,
  time,
  speed,
  onClip,
  onPlaying,
  onTime,
  onSpeed,
}: {
  clips: { name: string; duration: number }[];
  /** `'Bind pose'` or one of `clips`. */
  current: string;
  playing: boolean;
  /** Seconds into the current clip. */
  time: number;
  speed: number;
  onClip: (name: string) => void;
  onPlaying: (playing: boolean) => void;
  onTime: (seconds: number) => void;
  onSpeed: (speed: number) => void;
}) {
  const clip = clips.find((c) => c.name === current);
  const duration = clip?.duration ?? 0;
  const bind = !clip;

  return (
    <div className="timeline">
      <div className="timeline-clips">
        <Button
          size="xs"
          variant={bind ? 'secondary' : 'ghost'}
          aria-pressed={bind}
          className="timeline-clip"
          onClick={() => onClip(BIND_POSE)}
        >
          {BIND_POSE}
        </Button>
        {clips.map((option) => (
          <Button
            key={option.name}
            size="xs"
            variant={option.name === current ? 'secondary' : 'ghost'}
            aria-pressed={option.name === current}
            className="timeline-clip"
            onClick={() => onClip(option.name)}
          >
            {option.name}
          </Button>
        ))}
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        className="timeline-play"
        aria-label={playing ? 'Pause' : 'Play'}
        disabled={bind}
        onClick={() => onPlaying(!playing)}
      >
        {playing ? <Pause /> : <Play />}
      </Button>
      <input
        className="timeline-scrubber"
        type="range"
        aria-label="Clip time"
        min={0}
        max={duration || 1}
        // A sixtieth of a second: finer than that is below one rendered frame,
        // and coarser makes a short clip unscrubbable.
        step={1 / 60}
        value={Math.min(time, duration)}
        disabled={bind}
        onChange={(event) => {
          onPlaying(false);
          onTime(Number(event.target.value));
        }}
      />
      <span className="timeline-readout">
        {time.toFixed(2)} / {duration.toFixed(2)} s
      </span>
      <NativeSelect
        size="sm"
        className="timeline-speed"
        aria-label="Playback speed"
        value={String(speed)}
        onChange={(event) => onSpeed(Number(event.target.value))}
      >
        {SPEEDS.map((option) => (
          <NativeSelectOption key={option} value={String(option)}>
            {option}×
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}
