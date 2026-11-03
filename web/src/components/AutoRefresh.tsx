'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Keeps a page up to date while the worker settles things in the background. */
export function AutoRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(timer);
  }, [router, seconds]);
  return null;
}
