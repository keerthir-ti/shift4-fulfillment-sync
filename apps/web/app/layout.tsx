import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Shift4 local reproduction",
  description: "Simulator for the Oracle-to-Foundry fulfillment visibility gap",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
