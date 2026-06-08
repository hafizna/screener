import type { Metadata } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MP+Z screener",
  description: "Market profile + volume Z-score signal screener for Binance USDT-M futures",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        {children}
        <SpeedInsights />
      </body>
    </html>
  );
}
