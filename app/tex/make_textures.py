# ハプニング用のテクスチャ（OBS の「イメージマスク/ブレンド」でアバターにかける）を作る
import numpy as np, sys
from PIL import Image, ImageDraw, ImageFilter
W,H=540,960  # OBS が引きのばすので半分の大きさで十分
rng=np.random.default_rng(7)
def noise(scale_list):
    acc=np.zeros((H,W))
    for s,a in scale_list:
        n=rng.random((H//s+2,W//s+2))
        im=Image.fromarray((n*255).astype('uint8')).resize((W+s*2,H+s*2),Image.BICUBIC).crop((0,0,W,H))
        acc+=np.asarray(im,float)/255*a
    return acc/sum(a for _,a in scale_list)
def cracks(img,n,col,width,seed):
    r=np.random.default_rng(seed);d=ImageDraw.Draw(img)
    for _ in range(n):
        x,y=r.random()*W,r.random()*H;ang=r.random()*6.28
        for _ in range(int(r.integers(8,18))):
            ang+=r.normal(0,.6);L=r.uniform(15,45);nx,ny=x+np.cos(ang)*L,y+np.sin(ang)*L
            d.line([(x,y),(nx,ny)],fill=col,width=width)
            if r.random()<.3:
                a2=ang+r.choice([-1,1])*r.uniform(.6,1.2);d.line([(nx,ny),(nx+np.cos(a2)*L*.7,ny+np.sin(a2)*L*.7)],fill=col,width=max(1,width-1))
            x,y=nx,ny
    return img
out=sys.argv[1]
# 石：かける（乗算）用。明るい灰色のまだら＋細かいざらつき
n=noise([(160,1.0),(60,.7),(20,.5),(5,.35),(2,.25)])
g=(150+n*105).clip(0,255)
spots=noise([(40,1),(12,.5)]);g=g*(1-np.clip((spots-.55)*1.2,0,.25))
stone=Image.fromarray(np.stack([g*1.0,g*.97,g*.92],-1).clip(0,255).astype('uint8'))
stone.save(f'{out}/stone.png')
sc=cracks(stone.copy(),14,(40,36,32),3,3).filter(ImageFilter.SMOOTH)
sc=cracks(sc,10,(200,195,185),1,4);sc.save(f'{out}/stone_crack.png')
# 氷：たす（加算）用。黒地に、氷の面のハイライト・霜の白
ice=np.zeros((H,W,3))
f=noise([(200,1),(80,.6),(25,.4)])
ice+=np.stack([f*40,f*70,f*95],-1)
img=Image.fromarray(ice.clip(0,255).astype('uint8'));d=ImageDraw.Draw(img,'RGBA')
r=np.random.default_rng(11)
for _ in range(40):  # 面のハイライト（ななめの光）
    x,y=r.random()*W,r.random()*H;w=r.uniform(20,90);h=r.uniform(80,260)
    d.polygon([(x,y),(x+w,y-h*.3),(x+w*.6,y+h),(x-w*.3,y+h*.7)],fill=(150,200,255,int(r.uniform(25,70))))
fro=noise([(4,1),(2,.6)]);edge=noise([(120,1)])
fr=((fro>.62)*(edge>.55)*120)
img=Image.fromarray((np.asarray(img,float)+np.stack([fr,fr,fr],-1)).clip(0,255).astype('uint8')).filter(ImageFilter.GaussianBlur(.6))
img.save(f'{out}/ice.png')
ic=cracks(img.copy(),16,(235,250,255),2,5);ic.save(f'{out}/ice_crack.png')
# ぬれ（よだれ）：たす（加算）用。黒地に、たれるツヤの線と粒
wet=Image.new('RGB',(W,H),(0,0,0));d=ImageDraw.Draw(wet)
r=np.random.default_rng(21)
for _ in range(70):
    x=r.random()*W;y=r.random()*H*.7;L=r.uniform(60,260);w=int(r.uniform(3,10))
    c=int(r.uniform(90,190));d.line([(x,y),(x+r.normal(0,6),y+L)],fill=(c,c+10,c),width=w)
    d.ellipse([x-w*1.2,y+L-w*1.2,x+w*1.2,y+L+w*1.6],fill=(c+40,c+50,c+40))
for _ in range(220):
    x,y=r.random()*W,r.random()*H;s=r.uniform(2,7);c=int(r.uniform(120,230));d.ellipse([x-s,y-s,x+s,y+s],fill=(c,c,c))
wet=wet.filter(ImageFilter.GaussianBlur(1.6));wet.save(f'{out}/wet.png')
print('ok')
