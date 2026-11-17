interface ListSkeletonProps {
  /** Number of placeholder rows. Default 5. */
  rows?: number;
  /** Avatar diameter in px. Default 48, matching list rows. */
  avatarSize?: number;
}

/**
 * Shared loading skeleton for the ChatList / Calls / Status rows:
 * a pulsing avatar circle + two text lines per row, in both themes.
 * Replaces the three near-identical inline skeletons that were copied
 * into ChatListScreen, CallsScreen and StatusScreen.
 */
export default function ListSkeleton({ rows = 5, avatarSize = 48 }: ListSkeletonProps) {
  return (
    <div className="px-4 py-2 space-y-1" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center py-3 animate-pulse">
          <div
            className="rounded-full bg-gray-200 dark:bg-input-dark flex-shrink-0"
            style={{ width: avatarSize, height: avatarSize }}
          />
          <div className="ml-3 flex-1 space-y-2">
            <div className="h-3.5 w-1/3 rounded bg-gray-200 dark:bg-input-dark" />
            <div className="h-3 w-2/3 rounded bg-gray-200 dark:bg-input-dark" />
          </div>
        </div>
      ))}
    </div>
  );
}
