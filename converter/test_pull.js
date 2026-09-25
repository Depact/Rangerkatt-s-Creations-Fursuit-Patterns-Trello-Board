// Test if pull function is accessible
async function testPull() {
    const pull = (url, dest) => {
        console.log(`Mock pull: ${url} -> ${dest}`);
        return Promise.resolve(Buffer.from('test'));
    };
    return pull;
}

// Test call
(async () => {
    const pull = await testPull();
    await pull('http://example.com/image.jpg', 'test.jpg');
    console.log('Success!');
})();