import React, { useEffect, useState } from 'react';
import ForgeReconciler, { Heading, SectionMessage, Text } from '@forge/react';
import { invoke } from '@forge/bridge';

const App = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    invoke('getText', { example: 'my-invoke-variable' }).then(setData);
  }, []);

  return (
    <>
      <Heading size="medium">ctxpipe Connector</Heading>
      <SectionMessage appearance="info">
        <Text>
          This Forge app forwards lifecycle events to the ctxpipe backend so your
          organization can complete Atlassian setup.
        </Text>
      </SectionMessage>
      <Text>{data ? data : 'Loading connector context...'}</Text>
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
