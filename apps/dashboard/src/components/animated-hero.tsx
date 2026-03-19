"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";

type AnimatedHeroProps = {
  headline: ReactNode;
  description: ReactNode;
  cta: ReactNode;
  providers: ReactNode;
  demo: ReactNode;
};

export function AnimatedHero({ headline, description, cta, providers, demo }: AnimatedHeroProps) {
  return (
    <>
      {/* Headline — fades in first, underline triggers via CSS delay */}
      <motion.div
        className="pt-24 lg:pt-32 pb-1 lg:pb-2"
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        {headline}
      </motion.div>

      {/* Two-column: left content, right demo */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 lg:gap-12 items-start pb-8">
        {/* Left side — Content */}
        <div className="space-y-5">
          {/* Description */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut", delay: 0.65 }}
          >
            {description}
          </motion.div>

          {/* CTA (command + agent carousel) */}
          <motion.div
            className="space-y-4 pt-10"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut", delay: 0.95 }}
          >
            {cta}
          </motion.div>

          {/* Provider carousel */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: "easeOut", delay: 1.2 }}
          >
            {providers}
          </motion.div>
        </div>

        {/* Right side — Demo (not animated) */}
        {demo}
      </div>
    </>
  );
}
