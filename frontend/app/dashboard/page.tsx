import { Suspense } from "react";
import DashboardClient from "@/components/DashboardClient";

export const dynamic = "force-dynamic";

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="state-msg">Loading…</div>}>
      <DashboardClient />
    </Suspense>
  );
}
