'use client';
/**
 * Oddlings Studio.
 *
 * Agents author specs from code; this is where a person reviews what they
 * produced and corrects it. The page itself is only a mount point — the shell
 * and its store are in `components/studio/`.
 */
import { StudioProvider } from '@/components/studio/store';
import { StudioShell } from '@/components/studio/shell';

export default function StudioPage() {
  return (
    <StudioProvider>
      <StudioShell />
    </StudioProvider>
  );
}
