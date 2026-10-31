import React, { useContext, useEffect } from 'react';
import { homeRouterSwitch } from '../routers';
import appContext from '../stores/appContext';
import Sidebar from '../components/Sidebar';
import useLoading from '../hooks/useLoading';
import { MemoStorageMode } from '../memos';
import { shouldShowMemosShell } from '../capture/composerSurface';
import '../less/home.less';

function Home() {
  const {
    locationState: { pathname },
    globalState: { editMemoId },
  } = useContext(appContext);
  const loadingState = useLoading();
  const showShell = shouldShowMemosShell(pathname, Boolean(editMemoId) || MemoStorageMode === 'daily-notes');
  // const refresh = useRefresh();

  useEffect(() => {
    // const { user } = userService.getState();
    // if (!user) {
    //   userService
    //     .doSignIn()
    //     .catch(() => {
    //       // do nth
    //     })
    //     .finally(() => {
    //       // if (userService.getState().user) {
    //         loadingState.setFinish();
    //       // } else {
    //       //   locationService.replaceHistory("/signin");
    //       // }
    //     });
    // } else {
    loadingState.setFinish();

    // }
  }, []);

  return (
    <>
      {/* {loadingState.isLoading ? null : ( */}
      <section id="page-wrapper" className={showShell ? undefined : 'is-writing-surface'}>
        {showShell && <Sidebar />}
        <main className="content-wrapper">{homeRouterSwitch(pathname)}</main>
      </section>
      {/* )} */}
    </>
  );
}

export default Home;
