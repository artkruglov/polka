import React from "react";
import { Composition } from "remotion";
import { PeopleFilm, PEOPLE_DURATION } from "./films/people/Film";
import { CompaniesFilm, COMPANIES_DURATION } from "./films/companies/Film";

type Props = { fps: number; debug?: boolean };
const meta = (duration: number) => ({ props }: { props: Props }) => ({
  fps: props.fps,
  durationInFrames: Math.round(duration * props.fps),
});

export function Root() {
  return (
    <>
      <Composition id="PolkaPeople" component={PeopleFilm as never} width={1920} height={1080} fps={60}
        durationInFrames={Math.round(PEOPLE_DURATION * 60)} defaultProps={{ fps: 60 } as Props}
        calculateMetadata={meta(PEOPLE_DURATION) as never} />
      <Composition id="PolkaCompanies" component={CompaniesFilm as never} width={1920} height={1080} fps={60}
        durationInFrames={Math.round(COMPANIES_DURATION * 60)} defaultProps={{ fps: 60 } as Props}
        calculateMetadata={meta(COMPANIES_DURATION) as never} />
    </>
  );
}
