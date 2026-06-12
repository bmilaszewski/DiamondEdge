import { Suspense } from "react";
import PredictionsClient from "@/components/PredictionsClient";

export const dynamic = "force-dynamic";

export default function PredictionsPage() {
  return (
    <Suspense fallback={<div className="state-msg">Loading…</div>}>
      <PredictionsClient />
    </Suspense>
  );
}
