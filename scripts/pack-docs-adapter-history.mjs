function assertCompleteOrderedHistory(transitionCatalog) {
  const expectedIds = [
    "docs-2026-08-17-rc1", "docs-2026-08-17-rc7", "docs-2026-08-17-rc9",
    "docs-2026-08-18-rc1", "docs-2026-08-18-rc2", "docs-2026-08-18-rc3",
    "docs-2026-08-23-stable1", "docs-2026-08-24-stable2", "docs-2026-08-25-stable3",
    "docs-2026-08-28-stable8", "docs-2026-08-28-stable9.1", "docs-2026-08-31-stable10",
    "docs-2026-09-10-stable18", "docs-2026-09-10-stable19", "docs-2026-09-11-stable20",
    "docs-2026-09-12-stable21", "docs-2026-09-15-stable23",
    "docs-2026-09-21-stable26", "docs-2026-09-16-stable25"
  ];
  const actualIds = transitionCatalog.directTargetBundles.map(({ cohort }) => cohort.cohortId);
  if (transitionCatalog.currentSourceExecutors.length !== 0 ||
      actualIds.length !== expectedIds.length || new Set(actualIds).size !== expectedIds.length ||
      actualIds.some((id, index) => id !== expectedIds[index])) {
    throw new Error("Packed adapter transition history is incomplete, reordered, or duplicated.");
  }
}

function assertStable23Projection(stable23) {
  if (stable23 === undefined ||
      stable23.cohort.recordDigest !== "sha256:287fca0b66c212e93d865b3a54fcb681eda12f4f8954c077a59148a348a361c9" ||
      stable23.cohort.qualificationEventDigest !== "sha256:d65de3c1885c948dcdfa9b7fe79e9638ed74542ac32b85097ece90b5e02866d9" ||
      stable23.cohort.packages.docsProtocolAgentTeams.version !== "0.2.8" ||
      stable23.cohort.packages.engineeringFoundation.version !== "1.3.3" ||
      stable23.cohort.assets.transitionCatalogDigest !== "sha256:ab84cf314a24f9f32a3baabce0c814699366af6c2a4aeb91e59327bb6783606f" ||
      stable23.cohort.runtime.runtimeClosureDigest !== "sha256:6e768aa2e3be45c358d27d6a8a234f10806ba9ac22f1a003b36396ecc41ae157") {
    throw new Error("Packed adapter stable23 projection differs from central authority.");
  }
}

function assertStable26Projection(stable26, stable23) {
  if (stable26?.cohort.cohortId !== "docs-2026-09-21-stable26" ||
      stable26.cohort.recordDigest !== "sha256:c96167d5b3fa35b9f331c528e0b3055643e5ba702eb08d1eee1c412e78889c30" ||
      stable26.cohort.qualificationEventDigest !== "sha256:2b4b2b27583a6f2fd188f47ac8ec29e52db8224fcc66ab0ba1a364ba27312589" ||
      stable26.cohort.packages.docsProtocolAgentTeams.version !== "0.2.9" ||
      stable26.skillPath !== stable23.skillPath ||
      stable26.callerWorkflowPath !== stable23.callerWorkflowPath) {
    throw new Error("Packed adapter stable26 projection differs from central authority.");
  }
}

function hasStable25Authority(stable25) {
  return stable25?.cohort.recordDigest === "sha256:105c34ecc7fc422939b43daaca513f9ce630ce69d4a2820d39423fcdc13dcc61" &&
      stable25.cohort.qualificationEventDigest === "sha256:090325fe7992c7ca15e03a5375188d006d8c410f7a895a219fafb4e735f5d28b" &&
      stable25.cohort.assets.skillDigest === "sha256:a86d8c9b990124f11b50b1c6703e1aeb5e3b981d51f7e8f5c163c4f5b987d7c5" &&
      stable25.cohort.assets.callerWorkflowDigest === "sha256:d8d3b1281990179ee25ded67ba160f0e7573d2f70707b8c5b312d70b68d85125" &&
      stable25.cohort.assets.assetCatalogDigest === "sha256:3ec380a1a6dd8534824ba82ff23affba993e19e9cb6b3c5e424ea9973ad686da" &&
      stable25.cohort.assets.transitionCatalogDigest === "sha256:3b8d0895ed9fe39dfe14a90518bdc2c03fdb38e782bcd70411e0b7af0412f535" &&
      stable25.cohort.runtime.runtimeClosureDigest === "sha256:87cb5e3495848f453c1ac0e4dc8caa7d66828f0cab270cefd46d73dee2ea341a";
}

function hasStable25PackageVersionsAndIntegrity(stable25) {
  const packages = stable25.cohort.packages;
  return packages?.docsProtocolAgentTeams?.version === "0.2.9" &&
      packages.docsProtocolAgentTeams.integrity === "sha512-3wFo/xK/l0eLNseN2H8xrdPHWmjVIyZFy3OkAvyfLfMYVTT0Rm9L/R+33U4h2JeN5Mqb9kK8nCEvEfMY9Vxq0Q==" &&
      packages.engineeringFoundation?.version === "1.4.0" &&
      packages.engineeringFoundation.integrity === "sha512-m8rLOvctyXu+kqN4LyCW4LIz303a7p+ZIvx+oieYIwst6DNBpsWUu/Ux7UZM3fZH5JTYhB4eSEBEfi5lUTt4vQ==" &&
      packages.docsProtocol?.version === "0.6.0" &&
      packages.docsProtocol.integrity === "sha512-xSlc0DFTGh0jed9581LoToHAXwxxZMhzlItbPeoc67YNBSDxLCP8XNwK0LCMs4w8MLqY6silJDtpzsHFw2XSVg==" &&
      packages.documentAuthoring?.version === "0.3.0" &&
      packages.documentAuthoring.integrity === "sha512-LdNT8VHPQxXvuyXsCblFSeCmbEEZcXwiCTY1E+c0ZEWWJG0V2qoi95F8fHAwI4ngZLDmLr/yzHGyDqwkd9GBrA==" &&
      packages.repositoryMutation?.version === "0.2.0" &&
      packages.repositoryMutation.integrity === "sha512-a02kzLlWtQjPAG2fFo/HyC+T6D+hW+FJ+aNCYoTLuTdKqeuL50hIvSnQLMUbGajWBb4nAvaINvW2jvmJ+Qku0g==";
}

function assertStable25Projection(stable25, stable23, stable26) {
  if (!hasStable25Authority(stable25) || !hasStable25PackageVersionsAndIntegrity(stable25) ||
      stable25.skillPath !== stable23.skillPath ||
      stable25.callerWorkflowPath !== stable23.callerWorkflowPath ||
      stable25.skillDigest !== stable25.cohort.assets.skillDigest ||
      stable25.callerWorkflowDigest !== stable25.cohort.assets.callerWorkflowDigest ||
      stable25.agentsRouteDigest !== "sha256:08ca6c0782dbc36ace6359c8fe36807810f9668d999c7d9e8ead6bf281d9bf30" ||
      stable25.docsScriptsDigest !== "sha256:7a502ddeda5e3d0296b712b5c07e0905a9b7a8fcd374d37db8a02cb026a37881" ||
      stable25.agentsRouteDigest !== stable26.agentsRouteDigest ||
      stable25.docsScriptsDigest !== stable26.docsScriptsDigest) {
    throw new Error("Packed adapter stable25 projection differs from central authority.");
  }
}

export function assertPackedDocsAdapterHistory(transitionCatalog) {
  assertCompleteOrderedHistory(transitionCatalog);
  const bundles = transitionCatalog.directTargetBundles;
  const stable23 = bundles.find(({ cohort }) => cohort.cohortId === "docs-2026-09-15-stable23");
  assertStable23Projection(stable23);
  const stable26 = bundles.find(({ cohort }) => cohort.cohortId === "docs-2026-09-21-stable26");
  assertStable26Projection(stable26, stable23);
  const stable25 = bundles.find(({ cohort }) => cohort.cohortId === "docs-2026-09-16-stable25");
  assertStable25Projection(stable25, stable23, stable26);
  return stable23;
}
