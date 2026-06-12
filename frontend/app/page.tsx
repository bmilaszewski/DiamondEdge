import { Suspense } from "react";
import HubClient from "@/components/HubClient";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Suspense fallback={<div className="state-msg">Loading…</div>}>
      <HubClient />
    </Suspense>
  );
}
