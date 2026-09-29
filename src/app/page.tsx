import { redirect } from "next/navigation";
import { requireUser } from "@/db/server";

export default async function Home() {
  await requireUser();
  redirect("/dashboard");
}
