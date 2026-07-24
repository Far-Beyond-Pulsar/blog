import { getBlogIndex } from "@/utils/blog";
import BlogHomeClient from "./BlogHomeClient";
import {
  SITE_NAME,
  SITE_DESCRIPTION,
  SITE_ORIGIN_WITH_BASE,
  resolveOgImage,
} from "@/utils/site";

const homeImage = resolveOgImage(null, null, null, SITE_NAME);

export const metadata = {
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  alternates: { canonical: SITE_ORIGIN_WITH_BASE },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: SITE_ORIGIN_WITH_BASE,
    locale: "en_US",
    images: [homeImage],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    images: [homeImage.url],
  },
};

const BASE = process.env.NEXT_PUBLIC_CUSTOM_BASE_PATH || "";
const VISIBLE_TAGS = 10;

export default function BlogHome() {
  const { posts, allTags, tagFreq, allAuthors, total } = getBlogIndex();

  return (
    <BlogHomeClient
      posts={posts}
      allTags={allTags}
      tagFreq={tagFreq}
      allAuthors={allAuthors || []}
      total={total}
      base={BASE}
      visibleTags={VISIBLE_TAGS}
    />
  );
}
